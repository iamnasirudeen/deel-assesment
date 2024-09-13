const express = require("express");
const bodyParser = require("body-parser");
const { sequelize } = require("./model");
const { getProfile } = require("./middleware/getProfile");
const {
  getContractById,
  getAllContracts,
  getUnpaidJobs,
  makePaymentForJob,
  makeDeposit,
  getBestProfession,
  getBestClients,
} = require("./app.controller");
const app = express();
app.use(bodyParser.json());
app.set("sequelize", sequelize);
app.set("models", sequelize.models);

app.get("/contracts", getProfile, getAllContracts);

/**
 * FIXED
 * @returns contract by id
 */

app.get("/contracts/:id", getProfile, getContractById);

app.get("/jobs/unpaid", getProfile, getUnpaidJobs);

app.post("/jobs/:job_id/pay", getProfile, makePaymentForJob);

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
app.post("/balances/deposit/:userId", getProfile, makeDeposit);

app.get("/admin/best-profession", getBestProfession);

app.get("/admin/best-clients", getBestClients);

module.exports = app;
