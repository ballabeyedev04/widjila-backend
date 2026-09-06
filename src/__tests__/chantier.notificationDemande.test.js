'use strict';

/**
 * Tests — qui est prévenu quand une entreprise demande un chantier.
 *
 * ## Le défaut
 *
 * `_valideursDe` cherchait les valideurs DANS l'organisation du demandeur, et
 * écartait explicitement le super-admin plateforme au motif qu'il
 * n'appartient à aucune organisation.
 *
 * Or une organisation issue d'une inscription publique n'a qu'un seul compte,
 * de rôle 'Entreprise' (auth.service.js#register) : ni ChefProjet, ni
 * MaitreOuvrage. La requête ne ramenait donc AUCUN destinataire. L'entreprise
 * déposait sa demande, l'écran confirmait, et personne au monde n'était
 * prévenu — elle attendait une réponse que nul ne savait devoir donner.
 *
 * Et c'est bien le super-admin qui tranche : `requireRole(...GESTION)` garde
 * la validation, et 'Admin' y figure.
 *
 * ## Ce que ces tests verrouillent
 *
 * 1. Les super-admins plateforme reçoivent la demande, y compris quand
 *    l'organisation n'a aucun valideur à elle.
 * 2. Les valideurs de l'organisation la reçoivent toujours — élargir ne doit
 *    rien retirer.
 * 3. Le courriel nomme l'ENTREPRISE, pas seulement la personne : un
 *    super-admin reçoit les demandes de toute la plateforme.
 * 4. Le lien mène à l'écran où l'on décide, pas à un chantier qui n'existe
 *    pas encore.
 */

jest.mock('../models/index.js', () => ({
  Chantier: { create: jest.fn(), findByPk: jest.fn(), findOne: jest.fn(), findAndCountAll: jest.fn() },
  Utilisateur: { findAll: jest.fn(), findOne: jest.fn() },
  Organisation: { findByPk: jest.fn() },
  Plan: { update: jest.fn(), findAll: jest.fn(), count: jest.fn() },
  Reserve: { findAll: jest.fn(), count: jest.fn() },
  Batiment: {}, Etage: {}, Zone: {}, Lot: {}, Phase: {},
  Commentaire: {}, PieceJointe: {}, PlanHotspot: {}, ChantierMembre: {},
}));

jest.mock('../infrastructure/emailService.js', () => ({
  sendChantierValidationEmail: jest.fn().mockResolvedValue(true),
}));

const { Chantier, Utilisateur, Organisation } = require('../models/index.js');
const { sendChantierValidationEmail } = require('../infrastructure/emailService.js');
const ChantierService = require('../modules/chantier/service/chantier.service.js');

const ORG = 'org-1';
const AUTEUR = { id: 'u-ent', role: 'Entreprise', prenom: 'Moussa', nom: 'Diop' };

/** Le compte tel que le renvoie `Utilisateur.findAll`. */
const compte = (email, prenom) => ({ email, prenom, nom: prenom });

beforeEach(() => {
  jest.clearAllMocks();
  Organisation.findByPk.mockResolvedValue({ id: ORG, nom: 'Sotraco BTP' });
  Chantier.create.mockResolvedValue({ id: 'c-1', nom: 'Résidence Horizon', code: 'CH-A1B2' });
  Utilisateur.findOne.mockResolvedValue(null);
});

/** Déclenche une demande et rend les charges de courriel envoyées. */
async function demander(destinataires) {
  Utilisateur.findAll.mockResolvedValue(destinataires);
  const res = await ChantierService.creerChantier(ORG, { nom: 'Résidence Horizon' }, AUTEUR);
  expect(res.success).toBe(true);
  return sendChantierValidationEmail.mock.calls.map((c) => c[0]);
}

describe('destinataires', () => {
  it("prévient quelqu'un même quand l'organisation n'a aucun valideur à elle", async () => {
    // Le cas de TOUTE entreprise fraîchement inscrite : un seul compte, de
    // rôle 'Entreprise'. C'est précisément là que personne n'était prévenu.
    const charges = await demander([compte('admin@widjila.com', 'Balla')]);

    expect(charges).toHaveLength(1);
    expect(charges[0].to).toBe('admin@widjila.com');
  });

  it('la requête va chercher les super-admins EN PLUS des valideurs internes', async () => {
    await demander([]);

    const where = Utilisateur.findAll.mock.calls[0][0].where;
    const branches = where[Object.getOwnPropertySymbols(where).find((s) => String(s).includes('or'))];

    expect(branches).toHaveLength(2);
    // Une branche pour l'organisation, une pour le super-admin plateforme.
    expect(branches.some((b) => b.organisationId === ORG)).toBe(true);
    expect(branches.some((b) => b.role === 'Admin')).toBe(true);
  });

  it('ne prévient que des comptes ACTIFS', async () => {
    // Un compte suspendu ne tranchera rien : lui écrire ne ferait que laisser
    // croire que la demande est partie chez quelqu'un.
    await demander([]);

    expect(Utilisateur.findAll.mock.calls[0][0].where.statut).toBe('actif');
  });

  it('écrit à TOUS les destinataires, pas au premier trouvé', async () => {
    // Un seul destinataire en congé suffirait à bloquer une demande.
    const charges = await demander([
      compte('admin@widjila.com', 'Balla'),
      compte('chef@sotraco.sn', 'Awa'),
    ]);

    expect(charges.map((c) => c.to).sort()).toEqual(['admin@widjila.com', 'chef@sotraco.sn']);
  });

  it('ignore un compte sans adresse plutôt que de tout faire échouer', async () => {
    const charges = await demander([compte(null, 'Sans'), compte('admin@widjila.com', 'Balla')]);

    expect(charges).toHaveLength(1);
  });
});

describe('contenu du courriel', () => {
  it("nomme l'entreprise, et pas seulement la personne", async () => {
    // Un super-admin reçoit les demandes de toutes les organisations :
    // « Moussa Diop demande un chantier » ne lui dit pas de quelle société.
    const [charge] = await demander([compte('admin@widjila.com', 'Balla')]);

    expect(charge.organisationNom).toBe('Sotraco BTP');
    expect(charge.demandeurNom).toBe('Moussa Diop');
    expect(charge.variante).toBe('demande');
  });

  it('porte le chantier demandé, nom et code', async () => {
    const [charge] = await demander([compte('admin@widjila.com', 'Balla')]);

    expect(charge.chantierNom).toBe('Résidence Horizon');
    expect(charge.chantierCode).toBe('CH-A1B2');
    expect(charge.chantierId).toBe('c-1');
  });
});

describe('le courriel ne commande pas la demande', () => {
  it("une panne d'envoi ne perd pas la demande enregistrée", async () => {
    // Une demande enregistrée puis perdue parce que le fournisseur d'envoi
    // était indisponible serait le pire des deux mondes : l'utilisateur verrait
    // une erreur alors que sa demande existe.
    sendChantierValidationEmail.mockRejectedValueOnce(new Error('fournisseur indisponible'));
    Utilisateur.findAll.mockResolvedValue([compte('admin@widjila.com', 'Balla')]);

    const res = await ChantierService.creerChantier(ORG, { nom: 'Résidence Horizon' }, AUTEUR);

    expect(res.success).toBe(true);
    expect(Chantier.create).toHaveBeenCalled();
  });

  it("le chantier est enregistré AVANT que le courriel ne parte", async () => {
    // L'inverse ne se rattrape pas : un courriel annonçant une demande qui
    // n'existe pas envoie le valideur sur un écran vide.
    let creeAvant = false;
    sendChantierValidationEmail.mockImplementation(async () => {
      creeAvant = Chantier.create.mock.calls.length > 0;
      return true;
    });
    Utilisateur.findAll.mockResolvedValue([compte('admin@widjila.com', 'Balla')]);

    await ChantierService.creerChantier(ORG, { nom: 'Résidence Horizon' }, AUTEUR);

    expect(creeAvant).toBe(true);
  });
});

describe('le lien du courriel', () => {
  // Le lien est construit dans `emailService`, à partir de la variante.
  const emailService = jest.requireActual('../infrastructure/emailService.js');

  it("mène à l'écran de décision pour une demande", () => {
    // `/chantiers/:id` ne mène nulle part tant que la demande n'est pas
    // validée : le serveur écarte les demandes de la liste des chantiers.
    const source = require('fs').readFileSync(
      require('path').join(__dirname, '..', 'infrastructure', 'emailService.js'), 'utf8'
    );

    expect(source).toContain('/chantiers/demandes/${chantierId}');
    expect(emailService.sendChantierValidationEmail).toBeInstanceOf(Function);
  });
});
