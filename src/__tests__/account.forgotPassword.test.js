'use strict';

/**
 * Tests — AccountService.forgotPassword : aucune énumération de comptes.
 *
 * Ce que ces tests verrouillent :
 *
 *   1. MÊME MESSAGE, compte existant ou non — c'était déjà le cas, on le tient.
 *   2. MÊME COÛT : le chemin « compte inconnu » hache aussi (bcrypt). Sans cela,
 *      chronométrer la réponse suffisait à savoir si l'e-mail existe.
 *   3. MÊME ISSUE quand l'envoi du courriel échoue : l'erreur est journalisée,
 *      la réponse reste la même. Auparavant, un fournisseur de courriel en panne
 *      faisait répondre 500 aux seuls comptes existants — une énumération
 *      parfaite, déclenchée par une panne.
 */

jest.mock('../config/db.js', () => ({ transaction: jest.fn() }));
jest.mock('../models/index.js', () => ({
  Utilisateur: { findOne: jest.fn() },
  UserOtp: { destroy: jest.fn().mockResolvedValue(0), create: jest.fn().mockResolvedValue({}) },
}));
// Le service hache via utils/motDePasse.js (bcrypt natif) : c'est ce module
// qu'on double, plus `bcryptjs`.
jest.mock('../utils/motDePasse.js', () => ({ hash: jest.fn().mockResolvedValue('hash'), compare: jest.fn() }));
jest.mock('../infrastructure/emailService.js', () => ({ sendOtpEmail: jest.fn() }));
jest.mock('../infrastructure/storage.service.js', () => ({ storeFile: jest.fn(), deleteFile: jest.fn() }));
// Même raison que dans auth.lockout.test.js : `otplib` est un paquet ESM pur
// que le transform CommonJS de Jest ne sait pas charger.
jest.mock('../modules/auth/service/mfa.service.js', () => ({ verify: jest.fn() }));
jest.mock('../utils/logger.js', () => ({ error: jest.fn(), warn: jest.fn(), info: jest.fn() }));

const { Utilisateur, UserOtp } = require('../models/index.js');
const bcrypt = require('../utils/motDePasse.js');
const { sendOtpEmail } = require('../infrastructure/emailService.js');
const logger = require('../utils/logger.js');
const AccountService = require('../modules/account/service/account.service.js');

const MESSAGE = 'Si un compte existe avec cet email, un code de réinitialisation vient de lui être envoyé.';

beforeEach(() => {
  jest.clearAllMocks();
  bcrypt.hash.mockResolvedValue('hash');
  sendOtpEmail.mockResolvedValue(undefined);
});

describe('AccountService.forgotPassword — anti-énumération', () => {
  test('compte inconnu : message générique, et le même hachage que le chemin nominal', async () => {
    Utilisateur.findOne.mockResolvedValue(null);

    const resultat = await AccountService.forgotPassword('inconnu@test.com');

    expect(resultat).toEqual({ message: MESSAGE });
    // Le point du correctif : sans ce hachage, la réponse arrivait ~250 ms
    // plus tôt pour un compte inexistant.
    expect(bcrypt.hash).toHaveBeenCalledTimes(1);
    expect(sendOtpEmail).not.toHaveBeenCalled();
  });

  test('compte existant : même message, un code est créé et envoyé', async () => {
    Utilisateur.findOne.mockResolvedValue({ id: 'u1', email: 'chef@test.com', prenom: 'Awa', role: 'ChefProjet' });

    const resultat = await AccountService.forgotPassword('chef@test.com');

    expect(resultat).toEqual({ message: MESSAGE });
    expect(bcrypt.hash).toHaveBeenCalledTimes(1);
    expect(UserOtp.create).toHaveBeenCalledTimes(1);
    expect(sendOtpEmail).toHaveBeenCalledTimes(1);
  });

  test('échec d’envoi du courriel : la réponse NE CHANGE PAS, l’erreur est journalisée', async () => {
    Utilisateur.findOne.mockResolvedValue({ id: 'u1', email: 'chef@test.com', prenom: 'Awa', role: 'ChefProjet' });
    sendOtpEmail.mockRejectedValue(new Error('fournisseur en panne'));

    const resultat = await AccountService.forgotPassword('chef@test.com');
    // Laisse la promesse d'envoi se régler.
    await new Promise((resoudre) => setImmediate(resoudre));

    expect(resultat).toEqual({ message: MESSAGE });
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('fournisseur en panne'));
  });

  test('compte super-admin : traité comme un compte inconnu, aucun envoi', async () => {
    Utilisateur.findOne.mockResolvedValue({ id: 'a1', email: 'admin@test.com', prenom: 'Admin', role: 'Admin' });

    const resultat = await AccountService.forgotPassword('admin@test.com');

    expect(resultat).toEqual({ message: MESSAGE });
    expect(sendOtpEmail).not.toHaveBeenCalled();
  });
});
