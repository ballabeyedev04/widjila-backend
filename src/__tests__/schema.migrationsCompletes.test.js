'use strict';

/**
 * Les migrations savent-elles reproduire le schéma ?
 *
 * ## L'écart, et d'où il vient
 *
 * Le schéma de production a d'abord été bâti par `sequelize.sync()`, qui crée
 * les tables d'après les modèles. `sync()` a ensuite été retiré du démarrage
 * en production — à raison : une table créée dans le dos des migrations n'est
 * pas enregistrée dans `SequelizeMeta`, si bien que la migration censée la
 * décrire échoue plus tard.
 *
 * Mais le passage de relais n'a pas été fait : les tables déjà créées par
 * `sync()` n'ont jamais reçu de migration de création rétroactive. Les
 * migrations ne couvrent donc que ce qui a été ajouté APRÈS.
 *
 * ## Ce que cela coûte
 *
 * La production tourne — sa base existe. Ce qui ne fonctionne pas :
 *
 *   - provisionner un nouvel environnement (préproduction, bac à sable) ;
 *   - restaurer depuis les seules migrations après un incident ;
 *   - appliquer les `indexes:` déclarés dans les modèles, que `sync()` seul
 *     pose — 56 index n'existent donc pas en base.
 *
 * C'est aussi la mécanique exacte qui avait fait disparaître la table
 * `chantier_membres`, et avec elle la liste des chantiers.
 *
 * ## Ce que ce test fait, et ne fait pas
 *
 * Il ne corrige pas l'écart : le remède est une migration de référence
 * générée depuis le schéma réel (`pg_dump --schema-only`), puis marquée comme
 * appliquée sur les bases existantes. Cela ne s'écrit pas sans accès à la
 * base de production.
 *
 * Il EMPÊCHE l'écart de grandir. La liste ci-dessous fige les 32 tables
 * connues. Un modèle ajouté demain sans sa migration fera échouer ce test —
 * et son auteur saura, à ce moment-là, qu'il vient de créer une table que
 * personne ne pourra recréer.
 */

const fs = require('fs');
const path = require('path');

const MIGRATIONS = path.resolve(__dirname, '..', 'migrations');
const MODELES = path.resolve(__dirname, '..', 'models');

/**
 * Tables antérieures au passage aux migrations.
 *
 * Cette liste ne doit que RÉTRÉCIR — au fur et à mesure que la migration de
 * référence est écrite. Toute ligne ajoutée ici est une régression.
 */
const HERITAGE = new Set([
  'annotations', 'audit_log', 'batiments', 'chantiers', 'checklist_modeles',
  'checklists', 'commentaires', 'connexion_logs', 'convocations',
  'device_tokens', 'documents', 'equipes', 'etages', 'inspections', 'lots',
  'medias', 'mfa_challenge', 'notifications', 'organisations', 'partenaires',
  'phases', 'pieces_jointes', 'plans', 'rapports', 'refresh_tokens',
  'reserve_affectations', 'reserve_historiques', 'reserve_positions',
  'reserves', 'signatures', 'user_otps', 'zones',
]);

/** Tables qu'une migration sait créer. */
function tablesCreeesParMigration() {
  const tables = new Set();
  for (const f of fs.readdirSync(MIGRATIONS)) {
    if (!f.endsWith('.js')) continue;
    const src = fs.readFileSync(path.join(MIGRATIONS, f), 'utf8');
    for (const [, t] of src.matchAll(/createTable\(\s*'([a-z_]+)'/g)) tables.add(t);
    for (const [, t] of src.matchAll(/CREATE TABLE (?:IF NOT EXISTS )?"?([a-z_]+)"?/gi)) {
      tables.add(t.toLowerCase());
    }
  }
  return tables;
}

/** Tables décrites par un modèle. */
function tablesDesModeles() {
  const tables = new Map();
  for (const f of fs.readdirSync(MODELES)) {
    if (!f.endsWith('.model.js')) continue;
    const src = fs.readFileSync(path.join(MODELES, f), 'utf8');
    const m = /tableName:\s*'([a-z_]+)'/.exec(src);
    if (m) tables.set(m[1], f);
  }
  return tables;
}

describe('reproductibilité du schéma', () => {
  const parMigration = tablesCreeesParMigration();
  const parModele = tablesDesModeles();

  it('les deux inventaires sont bien constitués', () => {
    // Garde-fou : si la lecture cassait, les assertions suivantes passeraient
    // pour de mauvaises raisons.
    expect(parModele.size).toBeGreaterThan(30);
    expect(parMigration.size).toBeGreaterThan(5);
  });

  it('aucune NOUVELLE table ne s’ajoute sans migration de création', () => {
    const orphelines = [...parModele.keys()]
      .filter((t) => !parMigration.has(t) && !HERITAGE.has(t))
      .map((t) => `${t}  (${parModele.get(t)})`);

    expect(orphelines).toEqual([]);
  });

  it('la liste d’héritage ne contient rien de périmé', () => {
    // Une table qui reçoit enfin sa migration doit sortir de la liste. Sans
    // cette vérification, l'héritage resterait figé et masquerait le progrès
    // accompli.
    const reglees = [...HERITAGE].filter((t) => parMigration.has(t));

    expect(reglees).toEqual([]);
  });

  it('l’héritage ne recouvre que des tables réellement décrites', () => {
    // Un modèle supprimé doit disparaître de la liste, sinon elle décrit un
    // schéma qui n'existe plus.
    const fantomes = [...HERITAGE].filter((t) => !parModele.has(t));

    expect(fantomes).toEqual([]);
  });
});
