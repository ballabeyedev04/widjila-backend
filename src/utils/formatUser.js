'use strict';

/**
 * Sérialiseur utilisateur — garantit un format de réponse uniforme
 * et exclut toujours le mot de passe hashé (champ mot_de_passe).
 */

/**
 * Liste des attributs sûrs à exposer. À utiliser dans les requêtes
 * Sequelize (attributes:) pour ne JAMAIS renvoyer mfa_secret,
 * tentatives_connexion ou compte_bloque_jusqua (cf. audit sécurité).
 */
const SAFE_USER_ATTRIBUTES = [
  'id',
  'organisationId',
  'nom',
  'prenom',
  'email',
  'telephone',
  'photoProfil',
  'fonction',
  'role',
  'statut',
  'permissions',
  'langue',
  'dernierConnexion',
  'email_verifie',
  'mdp_temporaire',
  'createdAt',
  'updatedAt',
];

const formatUser = (utilisateur) => ({
  id: utilisateur.id,
  organisationId: utilisateur.organisationId || null,
  nom: utilisateur.nom,
  prenom: utilisateur.prenom,
  email: utilisateur.email,
  telephone: utilisateur.telephone,
  photoProfil: utilisateur.photoProfil,
  fonction: utilisateur.fonction,
  role: utilisateur.role,
  statut: utilisateur.statut,
  permissions: utilisateur.permissions || null,
  langue: utilisateur.langue,
  dernierConnexion: utilisateur.dernierConnexion,
  email_verifie: utilisateur.email_verifie,
  mdp_temporaire: utilisateur.mdp_temporaire,
});

module.exports = formatUser;
module.exports.SAFE_USER_ATTRIBUTES = SAFE_USER_ATTRIBUTES;
