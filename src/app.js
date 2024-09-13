const express = require("express");
const bodyParser = require("body-parser");
const { Op, Sequelize, fn, col } = require("sequelize");
const { sequelize } = require("./model");
const { getProfile } = require("./middleware/getProfile");
const {
  NotFoundExceptionError,
  BadRequestExceptionError,
} = require("./errors");
const app = express();
app.use(bodyParser.json());
app.set("sequelize", sequelize);
app.set("models", sequelize.models);

/**
 * FIXED
 * @returns contract by id
 */

app.get("/contracts", getProfile, async (req, res) => {
  const { Contract } = req.app.get("models");
  const contracts = await Contract.findAll({
    where: { ContractorId: req.profile.id },
  });

  res.json(contracts); // look into pagination
});

app.get("/contracts/:id", getProfile, async (req, res) => {
  const { Contract } = req.app.get("models");
  const { id } = req.params;
  const contract = await Contract.findOne({
    where: { id, ContractorId: req.profile.id },
  });
  if (!contract) return NotFoundExceptionError("Contract not found", res);
  res.json(contract);
});

app.get("/jobs/unpaid", getProfile, async (req, res) => {
  const { Job, Contract } = req.app.get("models");
  const unpaidJobs = await Job.findAll({
    where: { paid: null },
    include: {
      model: Contract,
      where: {
        status: "in_progress",
        [Op.or]: [
          { ClientId: req.profile.id },
          { ContractorId: req.profile.id },
        ],
      },
    },
  });
  res.json(unpaidJobs);
});

app.post("/jobs/:job_id/pay", getProfile, async (req, res) => {
  const { Job, Profile, Contract } = req.app.get("models");
  /**
   * check if job exists at all before running any operation
   * make sure job belongs to the current authenticated user
   * check if job has been paid for and return an error
   */
  const jobWithIdExist = await Job.findOne({
    where: { id: req.params.job_id },
    include: {
      model: Contract,
      where: {
        ClientId: req.profile.id,
      },
    },
    raw: true,
  });

  if (!jobWithIdExist) return NotFoundExceptionError("No job found", res);
  if (jobWithIdExist.paid)
    return BadRequestExceptionError("Job has already been paid for", res);

  try {
    const transaction = await sequelize.transaction({
      isolationLevel: Sequelize.Transaction.ISOLATION_LEVELS.REPEATABLE_READ,
    });

    const profile = await Profile.findOne({
      where: { id: req.profile.id },
      lock: true,
      transaction,
    });

    /**
     *
     * I can decide to manually check balance here since user profile has been locked (the code below)
     * or use atomic updates, I choose to use atomic updates instead
     *
     *  if (profile.balance < req.body.price)
     *  throw new Error("Insufficient balance");
     */

    // Atomic update for
    const job = await Job.update(
      { paid: true, paymentDate: new Date().toISOString() },
      {
        where: {
          id: jobWithIdExist.id,
          price: {
            [Op.gte]: profile.balance,
          },
        },
        transaction,
      }
    );
    if (!job[0])
      return NotFoundExceptionError(
        "Job not found or insufficient balance",
        res
      );

    // debit the client
    await Profile.decrement("balance", {
      by: jobWithIdExist.price,
      where: {
        id: profile.id,
      },
      transaction,
    });

    // credit the contractor
    await Profile.increment("balance", {
      by: jobWithIdExist.price,
      where: {
        id: jobWithIdExist["Contract"].ContractorId,
      },
      transaction,
    });

    await transaction.commit();
    res.status(200).json({ status: 200, message: "Job paid for successfully" });
  } catch (error) {
    await transaction.rollback();
    res.status(400).send(error.message);
  }
});

/**
 * personally I feel there's no need passing :userId here since a client
 * is a Profile and a client cannot deposit money to another client's account
 * meaning the :userId will still reference req.profile from the getProfile
 * middleware.
 *
 * I will just add validation checks to ensure the userId matches with what was
 * authenticated
 *
 * Also check if user is a client as the requirement states clearly that its a client
 */
app.post("/balances/deposit/:userId", getProfile, async (req, res) => {
  const userId = parseInt(req.params.userId || 0);
  const amount = parseInt(req.body.amount || 0);
  if (userId !== req.profile.id)
    return BadRequestExceptionError(
      "UserId doesnt match the authenticated id",
      res
    );
  if (req.profile.type !== "client")
    return BadRequestExceptionError(
      "Only clients are allowed to depoist money",
      res
    );

  const transaction = await sequelize.transaction({
    isolationLevel: Sequelize.Transaction.ISOLATION_LEVELS.REPEATABLE_READ,
  });

  try {
    const { Job, Profile, Contract } = req.app.get("models");

    /**
     * lock profile so user wont be able to perform any operation on it pending
     * when this operation is done so as to avoid race conditions
     */
    await Profile.findOne({
      where: { id: userId },
      lock: true,
      transaction,
    });

    // get the aggregation of the price of all unpaid jobs
    const totalJobPrices = await Job.sum("price", {
      where: { paid: null },
      include: {
        model: Contract,
        where: {
          ClientId: userId,
        },
      },
      transaction,
    });

    if (!totalJobPrices) throw new Error("User has no unpaid jobs");

    const oneQuarterOfTotalJobPrices = (totalJobPrices || 0) * 0.25;
    if (amount > oneQuarterOfTotalJobPrices) {
      throw new Error("User cannot deposit more than 25% of their total jobs");
    }

    await Profile.increment("balance", {
      by: amount,
      where: {
        id: userId,
      },
      transaction,
    });

    await transaction.commit();
    res.status(200).send({ status: 200, message: "Deposit successful" });
  } catch (error) {
    await transaction.rollback();
    res.status(400).send(error.message);
  }
});

app.get("/admin/best-profession", async (req, res) => {
  console.log("dates", req.query);
  const { Job, Profile, Contract } = req.app.get("models");

  const result = await Job.findAll({
    attributes: [[fn("SUM", col("price")), "totalEarnings"]],
    include: [
      {
        model: Contract,
        include: [
          {
            model: Profile,
            as: "Contractor",
            attributes: ["profession"],
          },
        ],
      },
    ],
    where: {
      paymentDate: {
        [Op.between]: [
          new Date(req.query.start).toISOString(),
          new Date(req.query.end).toISOString(),
        ],
      },
      paid: true,
    },
    group: ["Contract.Contractor.profession"],
    order: [[fn("SUM", col("price")), "DESC"]],
    limit: 1,
    raw: true,
  });

  const response = result.length ? result[0] : null;
  if (!response) return res.send("No contractor found within the date range");

  res.send({
    profession: response["Contract.Contractor.profession"],
    totalEarnings: response.totalEarnings,
  });
});

module.exports = app;
