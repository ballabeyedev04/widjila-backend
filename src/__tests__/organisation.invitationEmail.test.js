'use strict';

/**
 * Tests — le nouveau membre reçoit ses identifiants par courriel.
 *
 * ## Ce qui n'allait pas
 *
 * Le mot de passe temporaire n'est généré et connu du serveur qu'à UN seul
 * instant : sa création. Il ne partait alors nulle part — il était renvoyé à
 * l'appelant, qui l'affichait dans une fenêtre avec un bouton « J'ai noté »,
 * à charge pour lui de le transmettre ensuite. Une fenêtre refermée trop vite,
 * une application qui se ferme, et le compte devenait inutilisable : il
 * fallait le supprimer et le recréer.
 *
 * ## Ce qui est verrouillé ici
 *
 *   1. le courriel PART, à la bonne adresse, avec le nom de l'auteur, celui de
 *      l'entreprise, le rôle attribué et le mot de passe ;
 *   2. une panne d'envoi ne fait PAS échouer la création — le compte existe
 *      déjà en base quand l'envoi a lieu, et propager l'erreur ferait croire
 *      le contraire ;
 *   3. `emailEnvoye` dit la vérité dans les deux cas. C'est lui qui décide si
 *      le client doit encore afficher le mot de passe : le taire après un
 *      échec d'envoi le perdrait définitivement ;
 *   4. quand le créateur a CHOISI le mot de passe, le serveur ne le connaît
 *      qu'en empreinte : le courriel ne doit pas prétendre en transmettre un.
 */

jest.mock('../models/index.js', () => ({
  Utilisateur: { findOne: jest.fn(), create: jest.fn() },
  Organisation: { findByPk: jest.fn() },
  Equipe: {},
}));

jest.mock('../infrastructure/emailService.js', () => ({
  sendNouveauMembreEmail: jest.fn(),
}));

jest.mock('../infrastructure/storage.service.js', () => ({ storeFile: jest.fn() }));

const { Utilisateur, Organisation } = require('../models/index.js');
const { sendNouveauMembreEmail } = require('../infrastructure/emailService.js');
const OrganisationService = require('../modules/organisation/service/organisation.service.js');

const ORG = 'org-1';

const AUTEUR = { id: 'u-auteur', role: 'ChefProjet', prenom: 'Balla', nom: 'BEYE' };

const DONNEES = {
  nom: 'DIOP',
  prenom: 'Abdou',
  email: '  Abdou.DIOP@widjila.com ',
  role: 'ConducteurTravaux',
};

/** Le membre tel que Sequelize le renvoie après `create`. */
function membreCree(extra = {}) {
  return {
    id: 'u-nouveau',
    nom: 'DIOP',
    prenom: 'Abdou',
    email: 'abdou.diop@widjila.com',
    role: 'ConducteurTravaux',
    ...extra,
  };
}

beforeEach(() => {
  Utilisateur.findOne.mockResolvedValue(null); // ni email ni téléphone déjà pris
  Utilisateur.create.mockResolvedValue(membreCree());
  Organisation.findByPk.mockResolvedValue({ nom: 'Widjila BTP' });
  sendNouveauMembreEmail.mockResolvedValue({ id: 'msg-1' });
});

describe('ajouterMembre — courriel d’invitation', () => {
  it('envoie les identifiants au nouveau membre', async () => {
    const result = await OrganisationService.ajouterMembre(ORG, { ...DONNEES }, AUTEUR);

    expect(result.success).toBe(true);
    expect(sendNouveauMembreEmail).toHaveBeenCalledTimes(1);

    const charge = sendNouveauMembreEmail.mock.calls[0][0];
    // L'adresse NORMALISÉE, celle réellement enregistrée — pas la saisie
    // brute avec ses espaces et ses majuscules.
    expect(charge.to).toBe('abdou.diop@widjila.com');
    expect(charge.auteurNom).toBe('Balla BEYE');
    expect(charge.organisationNom).toBe('Widjila BTP');
    // Le LIBELLÉ du rôle, pas sa valeur technique : c'est un humain qui lit.
    expect(charge.role).toBe('Conducteur de travaux');
    expect(charge.motDePasse).toBe(result.motDePasseTemporaire);
    expect(charge.motDePasse).toEqual(expect.any(String));
  });

  it('annonce l’envoi par `emailEnvoye`', async () => {
    const result = await OrganisationService.ajouterMembre(ORG, { ...DONNEES }, AUTEUR);
    expect(result.emailEnvoye).toBe(true);
  });

  it('renvoie quand même le mot de passe — c’est l’unique occasion de le lire', async () => {
    const result = await OrganisationService.ajouterMembre(ORG, { ...DONNEES }, AUTEUR);
    expect(result.motDePasseTemporaire).toEqual(expect.any(String));
  });

  it('ne transmet PAS de mot de passe quand le créateur en a choisi un', async () => {
    // Le serveur ne le connaît alors qu'en empreinte. Annoncer un mot de passe
    // vide dans le message serait pire que de ne rien annoncer.
    await OrganisationService.ajouterMembre(
      ORG,
      { ...DONNEES, mot_de_passe: 'ChoisiParLAuteur1' },
      AUTEUR
    );
    expect(sendNouveauMembreEmail.mock.calls[0][0].motDePasse).toBeNull();
  });
});

describe('ajouterMembre — quand l’envoi échoue', () => {
  it('crée quand même le membre', async () => {
    sendNouveauMembreEmail.mockRejectedValue(new Error('Resend indisponible'));

    const result = await OrganisationService.ajouterMembre(ORG, { ...DONNEES }, AUTEUR);

    // Le compte est en base : lever ici ferait croire le contraire, et la
    // seconde tentative se heurterait à « un compte existe déjà ».
    expect(result.success).toBe(true);
    expect(Utilisateur.create).toHaveBeenCalledTimes(1);
  });

  it('le signale, pour que le mot de passe soit encore affiché', async () => {
    sendNouveauMembreEmail.mockRejectedValue(new Error('Resend indisponible'));

    const result = await OrganisationService.ajouterMembre(ORG, { ...DONNEES }, AUTEUR);

    expect(result.emailEnvoye).toBe(false);
    expect(result.motDePasseTemporaire).toEqual(expect.any(String));
  });

  it('traite l’absence de clé API comme un non-envoi', async () => {
    // `sendEmail` renvoie `null` sans lever quand RESEND_API_KEY manque
    // (développement local). Le compter comme un succès laisserait croire
    // qu'un mot de passe a été transmis alors qu'il est perdu.
    sendNouveauMembreEmail.mockResolvedValue(null);

    const result = await OrganisationService.ajouterMembre(ORG, { ...DONNEES }, AUTEUR);

    expect(result.emailEnvoye).toBe(false);
  });
});

describe('ajouterMembre — garde d’élévation conservée', () => {
  it('refuse toujours qu’une Entreprise crée un rôle de gestion', async () => {
    // Non-régression : le troisième paramètre est passé de « le rôle » à
    // « l'auteur complet ». La garde doit continuer de lire le rôle dedans.
    const result = await OrganisationService.ajouterMembre(
      ORG,
      { ...DONNEES, role: 'ChefProjet' },
      { id: 'u-2', role: 'Entreprise', prenom: 'A', nom: 'B' }
    );

    expect(result.success).toBe(false);
    expect(Utilisateur.create).not.toHaveBeenCalled();
    expect(sendNouveauMembreEmail).not.toHaveBeenCalled();
  });
});
