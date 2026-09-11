'use strict';

/**
 * Audit synchronisation — envoi de rapport REJOUÉ (cahier Rapports § 22).
 *
 * ## Le défaut
 *
 * L'envoi d'un rapport part en file d'attente quand le réseau manque, puis
 * est rejoué au retour de la connexion. « Rejoué » ne veut pas dire « jamais
 * arrivé » : si le serveur a expédié les courriels puis que la réponse s'est
 * perdue (pièce jointe lourde, délai dépassé côté mobile), le rejeu les
 * expédiait une SECONDE fois aux entreprises. Un document contractuel reçu en
 * double, c'est au mieux du bruit, au pire deux versions à réconcilier.
 *
 * ## La règle
 *
 * Le mobile joint une clé d'idempotence (`Idempotency-Key`) stable pour une
 * même intention d'envoi. Le serveur :
 *   - journalise la clé avec l'envoi réussi ;
 *   - répond succès SANS réexpédier si cette clé a déjà abouti ;
 *   - refuse en 409 `ENVOI_EN_COURS` si un envoi portant la même clé est en
 *     train de partir (verrou consultatif PostgreSQL : plusieurs processus
 *     PM2 servent l'API, un verrou en mémoire ne suffirait pas) ;
 *   - ne change rien au comportement SANS clé.
 */

const { Readable } = require('node:stream');

jest.mock('../models/index.js', () => require('./helpers/modelesRapportMock.js').creerModeles());

const mockOuvrirFichier = jest.fn();
jest.mock('../infrastructure/storage.service.js', () => ({
  ouvrirFichier: (...a) => mockOuvrirFichier(...a),
  storeFile: jest.fn(),
  deleteFile: jest.fn(),
}));

const mockSendEmail = jest.fn();
jest.mock('../infrastructure/emailService.js', () => ({
  sendEmail: (...a) => mockSendEmail(...a),
}));

jest.mock('../utils/logger.js', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const modeles = require('../models/index.js');
const { reinitialiser, instance } = require('./helpers/modelesRapportMock.js');
const sequelize = require('../config/db.js');
const RapportEnvoiService = require('../modules/rapport/service/rapportEnvoi.service.js');

const ORG = '11111111-1111-4111-8111-111111111111';
const CHANTIER = '22222222-2222-4222-8222-222222222222';
const AUTEUR = 'u-auteur';
const CLE = 'act-7f3c2b1a-envoi';

const TOITURE = { id: 'p1', nom: 'SARL Toiture', email: 'toiture@ex.fr', type: 'sous_traitant' };

let rapport;

beforeEach(() => {
  jest.restoreAllMocks();
  jest.clearAllMocks();
  reinitialiser(modeles);
  process.env.API_PUBLIC_URL = 'https://api.widjila.test';

  rapport = instance({
    id: 'rap-1',
    chantierId: CHANTIER,
    nom: 'Rapport global',
    statut: 'genere',
    fichier_url: '/uploads/rapports/rapport-global.pdf',
    taille_pdf: 250 * 1024,
    nb_reserves: 2,
    filtres: {},
    genere_le: new Date('2026-09-09T08:00:00Z'),
    chantier: {
      id: CHANTIER, nom: 'Résidence Horizon', code: 'RH-2026', organisationId: ORG,
      organisation: { id: ORG, nom: 'Widjila BTP' },
    },
  });

  modeles.Rapport.findOne.mockImplementation(async ({ include }) => (
    include?.[0]?.where?.organisationId === ORG ? rapport : null
  ));
  modeles.Reserve.findAll.mockResolvedValue([{ id: 'r1', partenaireId: 'p1' }]);
  modeles.Partenaire.findAll.mockImplementation(async ({ where }) => {
    if (where.type === 'client') return [];
    return [TOITURE];
  });
  modeles.ChantierMembre.findAll.mockResolvedValue([]);
  modeles.Utilisateur.findByPk.mockResolvedValue({ id: AUTEUR, prenom: 'Balla', nom: 'Beye', email: 'balla@widjila.com' });

  mockOuvrirFichier.mockImplementation(async () => ({ stream: Readable.from([Buffer.from('%PDF-1.7 rapport')]) }));
  mockSendEmail.mockResolvedValue({ id: 'msg_1' });

  // Aucune base réelle : la transaction exécute le rappel avec un faux
  // objet, et le verrou consultatif répond ce que le test décide.
  jest.spyOn(sequelize, 'transaction').mockImplementation(async (fn) => fn({ id: 't-fausse' }));
  jest.spyOn(sequelize, 'query').mockResolvedValue([{ verrou: true }]);
});

const journalEnvoi = () => modeles.RapportHistorique.create.mock.calls
  .map(([l]) => l)
  .find((l) => l.action === 'envoye');

describe('premier envoi avec une clé', () => {
  it('expédie une fois et JOURNALISE la clé', async () => {
    const r = await RapportEnvoiService.envoyer('rap-1', ORG, AUTEUR, { cleIdempotence: CLE });

    expect(r.success).toBe(true);
    expect(mockSendEmail).toHaveBeenCalledTimes(1);
    expect(journalEnvoi().metadata.cleIdempotence).toBe(CLE);
  });

  it('pose un verrou consultatif propre à la clé', async () => {
    await RapportEnvoiService.envoyer('rap-1', ORG, AUTEUR, { cleIdempotence: CLE });

    const [sql, options] = sequelize.query.mock.calls[0];
    expect(sql).toMatch(/pg_try_advisory_xact_lock/);
    expect(options.replacements.cle).toContain(CLE);
  });
});

describe('rejeu après une réponse perdue', () => {
  it('n’expédie PAS une seconde fois et répond succès', async () => {
    modeles.RapportHistorique.findOne.mockResolvedValue(instance({
      id: 'h-1', rapportId: 'rap-1', action: 'envoye',
      metadata: { cleIdempotence: CLE, to: ['toiture@ex.fr'], cc: [] },
    }));

    const r = await RapportEnvoiService.envoyer('rap-1', ORG, AUTEUR, { cleIdempotence: CLE });

    expect(r.success).toBe(true);
    expect(r.rejeu).toBe(true);
    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  it('ne rapproche QUE les envois réussis de ce rapport', async () => {
    // Un envoi en ÉCHEC portant la même clé n'a rien expédié : il doit
    // pouvoir être retenté.
    await RapportEnvoiService.envoyer('rap-1', ORG, AUTEUR, { cleIdempotence: CLE });

    const { where } = modeles.RapportHistorique.findOne.mock.calls[0][0];
    expect(where.rapportId).toBe('rap-1');
    expect(where.action).toBe('envoye');
  });
});

describe('envoi concurrent portant la même clé', () => {
  it('est refusé en 409 ENVOI_EN_COURS, sans rien expédier', async () => {
    sequelize.query.mockResolvedValue([{ verrou: false }]);

    const r = await RapportEnvoiService.envoyer('rap-1', ORG, AUTEUR, { cleIdempotence: CLE });

    expect(r.success).toBe(false);
    expect(r.code).toBe('ENVOI_EN_COURS');
    expect(r.statusCode).toBe(409);
    expect(mockSendEmail).not.toHaveBeenCalled();
  });
});

describe('sans clé', () => {
  it('le comportement historique est inchangé : aucun verrou, un envoi', async () => {
    const r = await RapportEnvoiService.envoyer('rap-1', ORG, AUTEUR);

    expect(r.success).toBe(true);
    expect(sequelize.transaction).not.toHaveBeenCalled();
    expect(mockSendEmail).toHaveBeenCalledTimes(1);
  });
});
