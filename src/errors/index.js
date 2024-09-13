const BadRequestExceptionError = (message, res) => {
  return res.status(400).send({ message, status: 400, success: false });
};

const NotAuthorizedExceptionError = (message, res) => {
  return res.status(401).send({ message, status: 401, success: false });
};

const NotFoundExceptionError = (message, res) => {
  return res.status(404).send({ message, status: 404, success: false });
};

module.exports = {
  BadRequestExceptionError,
  NotAuthorizedExceptionError,
  NotFoundExceptionError,
};
