const jwt = require('jsonwebtoken');

const SESSION_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '365d';

const firmarTokenSesion = (payload) =>
    jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: SESSION_EXPIRES_IN });

module.exports = {
    SESSION_EXPIRES_IN,
    firmarTokenSesion,
};
