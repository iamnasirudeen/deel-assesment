const { NotAuthorizedExceptionError } = require("../errors");

const getProfile = async (req, res, next) => {
  const { profile_id } = req.headers;
  const { Profile } = req.app.get("models");
  const profile = await Profile.findOne({
    where: { id: profile_id.trim() || 0 },
    raw: true,
  });

  if (!profile)
    return NotAuthorizedExceptionError(
      "Unauthorized to make this request",
      res
    );
  req.profile = profile;
  next();
};
module.exports = { getProfile };
