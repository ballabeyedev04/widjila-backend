'use strict';

/**
 * Migration de rattrapage (audit — Bugs & fiabilité, finding critique).
 *
 * Contexte : `server.js` a retiré `sequelize.sync({ force:false })` en
 * production ("les migrations sont la seule source de vérité du schéma"),
 * mais seule la table `utilisateur` était créée par une migration explicite
 * (`20260809000001-create-utilisateur.js`). Les 29 autres tables n'étaient
 * créées QUE par `sequelize.sync()` — un mécanisme qui ne tourne plus en
 * production. Résultat : un déploiement neuf (recette, disaster recovery,
 * nouveau serveur) ne peut pas démarrer correctement.
 *
 * Cette migration répare les deux findings liés (Bugs §1 et Index §5) :
 *
 *  1. Elle crée, table par table, toutes les tables des modèles Sequelize
 *     qui n'existent pas encore en base — en lisant DIRECTEMENT la
 *     définition du modèle (`models/index.js`), qui est la source de
 *     vérité actuelle du schéma. Pas de retranscription manuelle : aucun
 *     risque de divergence entre le modèle et la table créée.
 *
 *  2. Pour CHAQUE table (qu'elle vienne d'être créée ici, ou qu'elle existe
 *     déjà en production depuis un `sync()` antérieur), elle s'assure que
 *     tous les index déclarés dans le modèle existent réellement en base.
 *     Une base déjà à jour (sync() récent) ne voit rien changer ; une base
 *     dont certains index n'ont jamais été posés (ajoutés au modèle après
 *     le dernier sync()) se retrouve alignée.
 *
 * Idempotente et sûre à rejouer : aucune table existante n'est modifiée ou
 * recréée, `showAllTables()` protège les créations et les erreurs "already
 * exists" sur les index sont avalées silencieusement.
 *
 * ── ORDRE DE CRÉATION DES TABLES : ALGORITHME EN PLUSIEURS PASSES ─────────
 * Testé pour de vrai contre une base vierge (pas seulement relu) : la
 * première version, qui créait les tables dans l'ordre `Object.keys()` des
 * modèles, échouait dès la 3e table avec « la relation "utilisateur"
 * n'existe pas ».
 *
 * Cause : `belongsTo`/`hasMany` (models/index.js) injectent une contrainte
 * de clé étrangère RÉELLE sur la table enfant, même sans jamais écrire
 * `references:` à la main dans un fichier `*.model.js` — c'est le
 * comportement standard de Sequelize. La quasi-totalité des tables du
 * projet référence `utilisateur` (créateur, assigné, uploader…) ou une
 * autre table de ce lot : l'ordre `Object.keys()` (ordre de `require()`
 * dans models/index.js) ne respecte pas ce graphe de dépendances.
 *
 * Plutôt que de trier ce graphe à la main (fragile : tout nouveau modèle
 * avec une nouvelle association casserait l'ordre figé), cette migration
 * RETENTE en plusieurs passes : chaque table dont la création échoue parce
 * qu'elle référence une table pas encore créée est simplement reportée au
 * tour suivant. Le processus converge naturellement dès que les tables sont
 * traitées dans N'IMPORTE QUEL ordre — les passes suivantes résolvent les
 * dépendances au fur et à mesure. Une erreur qui n'est PAS "table
 * référencée absente" remonte immédiatement (schéma réellement cassé).
 *
 * `utilisateur` est créée ICI comme les autres (plus de cas particulier) —
 * `20260809000001-create-utilisateur.js`, qui tourne juste après, a été
 * rendue idempotente en conséquence (elle vérifie l'existence de la table
 * avant de la créer) : sur une base vierge, cette migration-ci crée déjà
 * `utilisateur`, et `create-utilisateur` n'a plus rien à faire. Sur une
 * base où `create-utilisateur` a déjà tourné par le passé (prod actuelle),
 * rien ne change : SequelizeMeta l'a déjà enregistrée, elle ne se rejoue
 * jamais.
 */

// Code SQLSTATE Postgres, indépendant de la langue du serveur — un message
// d'erreur, lui, varie selon la locale ("n'existe pas" en français, "does
// not exist" en anglais). Testé en conditions réelles : un serveur en
// locale French_France.1252 ne renvoie JAMAIS "does not exist" ni "already
// exists", donc un filtre uniquement textuel sur l'anglais laisse
// l'exception remonter. Sequelize expose le code du driver `pg` via
// `.parent` ou `.original` selon la version — on regarde les deux.
function codeErreurPg(err) {
  return err?.parent?.code || err?.original?.code;
}

// 42P01 = undefined_table (relation référencée absente). Repli textuel
// bilingue en dernier recours si le code n'est pas exposé.
function estTableReferenceeAbsente(err) {
  if (codeErreurPg(err) === '42P01') return true;
  return /n'existe pas|does not exist/i.test(err.message || '');
}

// 42710 = duplicate_object (index/contrainte du même nom), 42P07 =
// duplicate_table (table/relation du même nom). Même repli bilingue.
function estObjetDejaExistant(err) {
  const code = codeErreurPg(err);
  if (code === '42710' || code === '42P07' || code === '42701') return true;
  return /already exists|existe déjà/i.test(err.message || '');
}

// Colonnes qui n'ont pas de représentation en base (calculées à la volée).
// Aucun modèle du projet n'en déclare aujourd'hui, mais on filtre par
// prudence pour que cette migration reste correcte si un futur modèle en
// ajoute une.
function estColonneMaterialisable(attribut) {
  const type = attribut?.type;
  return !(type && type.key === 'VIRTUAL');
}

function attributsPourCreateTable(model) {
  const attributs = {};
  for (const [nom, def] of Object.entries(model.rawAttributes)) {
    if (!estColonneMaterialisable(def)) continue;
    attributs[nom] = def;
  }
  return attributs;
}

module.exports = {
  async up(queryInterface) {
    // Chemin relatif classique : les migrations sequelize-cli tournent
    // toujours avec ce fichier comme module courant.
    const db = require('../models/index.js');

    // On itère sur `sequelize.models` plutôt que sur les exports de
    // `models/index.js` : les associations `belongsToMany(..., { through:
    // 'equipe_membres' })` (chaîne, pas un modèle) enregistrent une table de
    // jonction implicite sur l'instance Sequelize SANS l'exporter depuis
    // index.js. En se limitant aux exports, cette migration aurait oublié
    // `equipe_membres` — la seule table encore créée uniquement par sync().
    const modeles = db.Utilisateur.sequelize.models;
    const tousLesModeles = Object.values(modeles).filter(
      (m) => m && typeof m.getTableName === 'function'
    );

    const tablesExistantes = new Set(await queryInterface.showAllTables());
    let restants = tousLesModeles.filter((m) => !tablesExistantes.has(m.getTableName()));

    // ── Passe 1 : création des tables, en autant de tours que nécessaire ──
    let progres = true;
    while (restants.length && progres) {
      progres = false;
      const echecs = [];

      for (const model of restants) {
        const nomTable = model.getTableName();
        try {
          await queryInterface.createTable(nomTable, attributsPourCreateTable(model));
          console.log(`[migration] Table créée : ${nomTable}`);
          tablesExistantes.add(nomTable);
          progres = true;
        } catch (err) {
          if (!estTableReferenceeAbsente(err)) throw err;
          echecs.push(model); // dépendance pas encore créée → reporté au tour suivant
        }
      }
      restants = echecs;
    }

    if (restants.length) {
      // Progrès nul sur un tour entier : dépendance circulaire réelle, ou
      // erreur autre que "table absente" mal détectée par le filtre
      // ci-dessus. On préfère échouer bruyamment plutôt que de laisser un
      // schéma partiellement créé sans que personne ne le sache.
      throw new Error(
        'Impossible de créer ces tables après plusieurs passes '
        + '(dépendance non résolue ou erreur inattendue) : '
        + restants.map((m) => m.getTableName()).join(', ')
      );
    }

    // ── Passe 2 : index déclarés dans chaque modèle ────────────────────────
    // Toutes les tables existent désormais (qu'elles viennent d'être créées
    // ci-dessus ou qu'elles existaient déjà) : l'ordre n'a plus d'importance.
    for (const model of tousLesModeles) {
      const nomTable = model.getTableName();
      const indexDeclares = (model.options && model.options.indexes) || [];
      for (const index of indexDeclares) {
        try {
          await queryInterface.addIndex(nomTable, index);
        } catch (err) {
          // Index déjà en place : rien à faire. Toute autre erreur doit
          // remonter (schéma cassé).
          if (!estObjetDejaExistant(err)) throw err;
        }
      }
    }
  },

  // Volontairement no-op : un rollback ne doit pas supprimer des tables ou
  // des index de production potentiellement déjà peuplés. Le retour arrière
  // d'une table réellement manquante doit être fait manuellement, en
  // connaissance de cause.
  async down() {},
};
