const express = require("express");
const bodyParser = require("body-parser");
const { sequelize, Op } = require("./model");
const { getProfile } = require("./middleware/getProfile");
const { NotFoundExceptionError } = require("./errors");
const app = express();
app.use(bodyParser.json());
app.set("sequelize", sequelize);
app.set("models", sequelize.models);

/**
 * FIX ME!
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
    where: { paid: false },
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

module.exports = app;
