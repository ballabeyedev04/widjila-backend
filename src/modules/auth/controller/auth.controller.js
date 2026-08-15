'use strict';

const AuthService = require('../service/auth.service.js');
const formatUser = require('../../../utils/formatUser.js');
const asyncHandler = require('../../../middlewares/asyncHandler.js');
const { BadRequestError } = require('../../../errors/AppError.js');

const REFRESH_COOKIE_OPTS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'strict',
  maxAge: 7 * 24 * 60 * 60 * 1000,
};

// Jeton MFA intermédiaire : cookie httpOnly court (10 min) — jamais dans le body.
const MFA_COOKIE_OPTS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'strict',
  maxAge: 10 * 60 * 1000,
};

/** Métadonnées d'audit extraites de la requête (journal des connexions). */
const _meta = (req) => ({ ip: req.ip, userAgent: req.headers['user-agent'] || null });

exports.inscriptionUser = asyncHandler(async (req, res) => {
  const result = await AuthService.register(req.body);
  if (!result.success) throw new BadRequestError(result.message);

  res.status(201).json({
    success: true,
    message: result.message,
    data: { utilisateur: formatUser(result.utilisateur) },
  });
});

exports.login = asyncHandler(async (req, res) => {
  const result = await AuthService.login(req.body, _meta(req));
  if (!result.success) throw new BadRequestError(result.message);

  // Challenge MFA : jeton MFA en cookie httpOnly (jamais exposé au JS)
  if (result.mfaRequise) {
    res.cookie('mfaToken', result.mfaToken, MFA_COOKIE_OPTS);
    return res.status(200).json({
      success: true,
      message: 'Code de vérification requis (authentification à deux facteurs)',
      data: {
        mfaRequise: true,
        utilisateur: formatUser(result.utilisateur),
      },
    });
  }

  res.cookie('refreshToken', result.refreshToken, REFRESH_COOKIE_OPTS);
  res.status(200).json({
    success: true,
    message: 'Connexion réussie',
    data: {
      token: result.token,
      utilisateur: formatUser(result.utilisateur),
    },
  });
});

exports.verifierMfa = asyncHandler(async (req, res) => {
  // Le jeton MFA arrive via le cookie httpOnly (fallback body pour compatibilité)
  const mfaToken = req.cookies?.mfaToken || req.body?.mfaToken;
  const result = await AuthService.verifierMfa({ mfaToken, code: req.body.code }, _meta(req));
  if (!result.success) {
    res.clearCookie('mfaToken');
    throw new BadRequestError(result.message);
  }

  res.clearCookie('mfaToken'); // challenge consommé
  res.cookie('refreshToken', result.refreshToken, REFRESH_COOKIE_OPTS);
  res.status(200).json({
    success: true,
    message: 'Connexion réussie',
    data: {
      token: result.token,
      utilisateur: formatUser(result.utilisateur),
    },
  });
});

exports.refresh = asyncHandler(async (req, res) => {
  const refreshToken = req.cookies?.refreshToken || req.body?.refreshToken;
  if (!refreshToken) throw new BadRequestError('refreshToken manquant');

  const result = await AuthService.refresh({ refreshToken });
  if (!result.success) {
    res.clearCookie('refreshToken');
    throw new BadRequestError(result.message);
  }

  res.cookie('refreshToken', result.refreshToken, REFRESH_COOKIE_OPTS);
  res.status(200).json({
    success: true,
    message: 'Token renouvelé',
    data: { token: result.token },
  });
});

exports.logout = asyncHandler(async (req, res) => {
  const refreshToken = req.cookies?.refreshToken || req.body?.refreshToken;
  await AuthService.logout({ refreshToken });
  res.clearCookie('refreshToken');
  res.clearCookie('mfaToken');
  res.status(200).json({ success: true, message: 'Déconnexion réussie' });
});

// -------------------- VÉRIFICATION EMAIL (audit M5) --------------------
exports.verifierEmail = asyncHandler(async (req, res) => {
  const result = await AuthService.verifierEmail(req.body.token);
  if (!result.success) throw new BadRequestError(result.message);
  res.status(200).json({ success: true, message: result.message });
});
