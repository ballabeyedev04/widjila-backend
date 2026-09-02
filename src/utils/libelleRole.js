'use strict';

/**
 * Libellés lisibles des rôles utilisateur.
 *
 * Les clés sont les valeurs de `ROLE_UTILISATEUR` (`config/enums.js`) — celles
 * stockées en base et transportées par l'API. Ce fichier ne sert qu'à les
 * rendre présentables partout où un humain les lit : un PDF de rapport, un
 * courriel d'invitation.
 *
 * ## Pourquoi une table partagée
 *
 * Cette correspondance vivait dans `rapportPdf.js`. L'e-mail d'invitation d'un
 * nouveau membre en avait besoin à son tour ; la recopier aurait garanti
 * qu'un jour l'un des deux annonce « ConducteurTravaux » et l'autre
 * « Conducteur de travaux » pour la même personne.
 */
const LIBELLE_ROLE = {
  Admin: 'Administrateur',
  ChefProjet: 'Chef de projet',
  ConducteurTravaux: 'Conducteur de travaux',
  BureauControle: 'Bureau de contrôle',
  MaitreOuvrage: "Maître d'ouvrage",
  MaitreOeuvre: "Maître d'œuvre",
  Entreprise: 'Entreprise',
  Client: 'Client',
  Pilote: 'Pilote de chantier',
  SousTraitant: 'Sous-traitant',
};

/**
 * Libellé d'un rôle, ou le rôle brut si on ne le connaît pas.
 *
 * Le repli est volontaire : un rôle ajouté à l'énumération sans passer ici
 * doit s'afficher tel quel plutôt que de laisser un vide dans une phrase
 * (« vous a ajouté en tant que . »).
 *
 * @param {string} role
 * @returns {string}
 */
function libelleRole(role) {
  return LIBELLE_ROLE[role] || role || '';
}

module.exports = { LIBELLE_ROLE, libelleRole };
