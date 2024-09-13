const { Op, Sequelize, fn, col } = require("sequelize");
const {
  NotFoundExceptionError,
  BadRequestExceptionError,
} = require("./errors");

const getContractById = async (req, res) => {
  const { Contract } = req.app.get("models");
  const { id } = req.params;
  const contract = await Contract.findOne({
    where: { id, ContractorId: req.profile.id },
  });
  if (!contract) return NotFoundExceptionError("Contract not found", res);
  res.send(contract);
};

const getAllContracts = async (req, res) => {
  const { Contract } = req.app.get("models");
  const contracts = await Contract.findAll({
    where: { ContractorId: req.profile.id, status: { [Op.ne]: "terminated" } },
  });

  res.send(contracts);
};

const getUnpaidJobs = async (req, res) => {
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
  res.send(unpaidJobs);
};

const makePaymentForJob = async (req, res) => {
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

  const transaction = await sequelize.transaction({
    isolationLevel: Sequelize.Transaction.ISOLATION_LEVELS.REPEATABLE_READ,
  });

  try {
    const profile = await Profile.findOne({
      where: {
        id: req.profile.id,
        balance: { [Op.gte]: jobWithIdExist.price },
      },
      lock: true,
      transaction,
    });

    /**
     * the reason for throwing insufficient funds is due to the fact user actually does
     * exist, if not, it wont have passed the getProfile middleware but the database
     * wasnt able to find a user (the auth user) with sufficient balance to pay for the user
     */
    if (!profile) throw new Error("Insufficient funds");

    await Job.update(
      { paid: true, paymentDate: new Date().toISOString() },
      {
        where: {
          id: jobWithIdExist.id,
        },
        transaction,
      }
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
        id: jobWithIdExist["Contract.ContractorId"],
      },
      transaction,
    });

    await transaction.commit();
    res.status(200).send({ status: 200, message: "Job paid for successfully" });
  } catch (error) {
    await transaction.rollback();
    res.status(400).send(error.message);
  }
};

const makeDeposit = async (req, res) => {
  const userId = parseInt(req.params.userId || 0);
  const amount = parseFloat(req.body.amount || 0); // 231.11 is a float which is an example of a walletBalance so I assume user can have added cents on their money when funding
  if (userId !== req.profile.id)
    return BadRequestExceptionError(
      "UserId doesnt match the authenticated id",
      res
    );
  if (req.profile.type !== "client")
    return BadRequestExceptionError(
      "Only clients are allowed to deposit money",
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
};

const getBestProfession = async (req, res) => {
  const { start, end } = req.query;
  if (!start || !end)
    return BadRequestExceptionError("Start and End Date has to be passed", res);

  const { Job, Profile, Contract } = req.app.get("models");

  const result = await Job.findAll({
    attributes: [[fn("SUM", col("price")), "totalEarnings"]],
    include: {
      model: Contract,
      include: [
        {
          model: Profile,
          as: "Contractor",
          attributes: ["profession"],
        },
      ],
    },
    where: {
      paymentDate: {
        [Op.between]: [
          new Date(start).toISOString(),
          new Date(end).toISOString(),
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
};

const getBestClients = async (req, res) => {
  const { start, end, limit } = req.query;
  const { Job, Profile, Contract } = req.app.get("models");

  const result = await Job.findAll({
    attributes: [
      [col("Contract.ClientId"), "ClientId"],
      [fn("SUM", col("price")), "totalPaid"],
    ],
    include: {
      model: Contract,
      attributes: ["ClientId"],
      include: [
        {
          model: Profile,
          as: "Client",
          attributes: ["id", "firstName", "lastName"],
        },
      ],
    },
    where: {
      paymentDate: {
        [Op.between]: [
          new Date(start).toISOString(),
          new Date(end).toISOString(),
        ],
      },
      paid: true,
    },
    group: ["Contract.ClientId"],
    order: [[fn("SUM", col("price")), "DESC"]],
    limit: limit || 2,
  });

  const clients = result.map((record) => ({
    id: record.Contract.Client.id,
    fullName: `${record.Contract.Client.firstName} ${record.Contract.Client.lastName}`,
    paid: record.get("totalPaid"),
  }));

  res.status(200).send(clients);
};

module.exports = {
  getContractById,
  getAllContracts,
  getUnpaidJobs,
  makePaymentForJob,
  makeDeposit,
  getBestProfession,
  getBestClients,
};
