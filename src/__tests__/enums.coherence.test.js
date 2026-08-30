'use strict';

/**
 * Tests — cohérence du catalogue d'énumérations avec la BASE.
 *
 * `config/enums.js` devient la source unique lue par les schémas Joi, l'export
 * Excel et les deux clients (via `/referentiels/enums`). Il ne vaut donc que
 * s'il dit la VÉRITÉ : une valeur absente ici est refusée par la validation
 * alors que la colonne l'accepte ; une valeur en trop est proposée à
 * l'utilisateur puis rejetée par PostgreSQL au moment de l'écriture.
 *
 * Ce test lit les `DataTypes.ENUM` réellement déclarés dans les modèles et les
 * compare au catalogue. Il échouera donc si quelqu'un modifie l'un sans
 * l'autre — c'est précisément son rôle.
 */

const path = require('path');
const fs = require('fs');

const ENUMS = require('../config/enums.js');

const DOSSIER_MODELES = path.join(__dirname, '..', 'models');

/**
 * Extrait les listes `ENUM(...)` d'un fichier de modèle, dans l'ordre.
 *
 * Lecture du SOURCE plutôt qu'import du modèle : charger un modèle Sequelize
 * ouvre une connexion à la base, ce qu'un test unitaire n'a pas à faire.
 */
function enumsDuModele(nomFichier) {
  const source = fs.readFileSync(path.join(DOSSIER_MODELES, nomFichier), 'utf8');
  return [...source.matchAll(/DataTypes\.ENUM\(([^)]*)\)/g)].map(([, contenu]) =>
    [...contenu.matchAll(/'([^']*)'/g)].map(([, valeur]) => valeur)
  );
}

/** La n-ième liste ENUM du fichier, dans l'ordre de déclaration. */
function enumModele(nomFichier, index) {
  const listes = enumsDuModele(nomFichier);
  if (!listes[index]) {
    throw new Error(`${nomFichier} : pas d'ENUM à l'index ${index}`);
  }
  return listes[index];
}

describe('config/enums.js reflète les colonnes ENUM', () => {
  const cas = [
    ['rôles utilisateur', 'utilisateur.model.js', 0, ENUMS.ROLE_UTILISATEUR],
    ['statuts utilisateur', 'utilisateur.model.js', 1, ENUMS.STATUT_UTILISATEUR],
    ['statuts chantier', 'chantier.model.js', 0, ENUMS.STATUT_CHANTIER],
    ['types inspection', 'inspection.model.js', 0, ENUMS.TYPE_INSPECTION],
    ['statuts inspection', 'inspection.model.js', 1, ENUMS.STATUT_INSPECTION],
    ['statuts convocation', 'convocation.model.js', 0, ENUMS.STATUT_CONVOCATION],
    ['types document', 'document.model.js', 0, ENUMS.TYPE_DOCUMENT],
    ['statuts document', 'document.model.js', 1, ENUMS.STATUT_DOCUMENT],
    ['types partenaire', 'partenaire.model.js', 0, ENUMS.TYPE_PARTENAIRE],
    ['types organisation', 'organisation.model.js', 0, ENUMS.TYPE_ORGANISATION],
    ['types plan', 'plan.model.js', 0, ENUMS.TYPE_PLAN],
    ['types média', 'media.model.js', 0, ENUMS.TYPE_MEDIA],
    ['cibles de repère', 'planHotspot.model.js', 0, ENUMS.CIBLE_HOTSPOT],
  ];

  it.each(cas)('%s', (_libelle, fichier, index, attendu) => {
    expect(enumModele(fichier, index)).toEqual(attendu);
  });

  it('sévérité et priorité partagent la même échelle', () => {
    // Les deux colonnes du modèle réserve, déclarées séparément, doivent
    // rester identiques : les tris et le calcul des retards s'appuient dessus.
    const listes = enumsDuModele('reserve.model.js');
    expect(listes[0]).toEqual(ENUMS.SEVERITE_PRIORITE);
    expect(listes[1]).toEqual(ENUMS.SEVERITE_PRIORITE);
  });

  it('catégories de réserve (colonne historique)', () => {
    expect(enumsDuModele('reserve.model.js')[2]).toEqual(ENUMS.CATEGORIE_RESERVE);
  });

  it('statuts de réserve, DANS L’ORDRE du cycle de vie', () => {
    // L'ordre sert au tri des colonnes de suivi : le comparer avec `toEqual`
    // et non comme un ensemble est délibéré.
    expect(enumsDuModele('reserve.model.js')[3]).toEqual(ENUMS.STATUT_RESERVE);
  });

  it('périodes et statuts de souscription', () => {
    const listes = enumsDuModele('abonnementSouscrit.model.js');
    expect(listes[0]).toEqual(ENUMS.PERIODE_ABONNEMENT);
    expect(listes[1]).toEqual(ENUMS.STATUT_SOUSCRIPTION);
  });
});

describe('vue publique servie aux clients', () => {
  it('ne contient que des tableaux de chaînes non vides', () => {
    for (const [cle, valeurs] of Object.entries(ENUMS.VUE_PUBLIQUE)) {
      expect(Array.isArray(valeurs)).toBe(true);
      expect(valeurs.length).toBeGreaterThan(0);
      valeurs.forEach((v) => expect(typeof v).toBe('string'));
      expect(new Set(valeurs).size).toBe(valeurs.length, `doublon dans ${cle}`);
    }
  });

  it('n’expose AUCUNE formule d’abonnement', () => {
    // Les formules vivent en base et sont administrables : les figer ici
    // recréerait exactement le doublon qu'on vient de supprimer, et le web
    // afficherait des offres qui ne correspondent pas au catalogue vendu.
    const serialise = JSON.stringify(ENUMS.VUE_PUBLIQUE).toLowerCase();
    for (const obsolete of ['starter', 'business', 'enterprise', 'essentiel']) {
      expect(serialise).not.toContain(obsolete);
    }
  });

  it('expose les clés attendues par le web et le mobile', () => {
    // Retirer une clé casserait silencieusement un filtre côté client : la
    // liste devient vide, sans erreur.
    for (const cle of [
      'roles', 'statutsChantier', 'statutsReserve', 'severites', 'priorites',
      'statutsUtilisateur', 'typesDocument', 'statutsDocument',
      'typesInspection', 'statutsInspection', 'statutsConvocation',
      'typesPartenaire',
    ]) {
      expect(ENUMS.VUE_PUBLIQUE[cle]).toBeDefined();
    }
  });
});
