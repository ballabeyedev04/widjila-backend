'use strict';

/**
 * Audit de cohérence des requêtes Sequelize avec les modèles déclarés.
 *
 * ## Pourquoi
 *
 * Deux pannes de production venaient d'un décalage entre le code et les
 * modèles, que les tests à doublures (modèles simulés) ne peuvent pas voir :
 *   - « User is not associated to ChantierMembre! » — un include sans
 *     association déclarée : aucun rapport PDF ne sortait ;
 *   - un filtre `chantierId` sur `reserve_historiques`, qui n'a pas cette
 *     colonne : le délai moyen de traitement échouait à chaque appel.
 *
 * ## Ce qui est vérifié, sans base de données
 *
 *   1. INCLUDES — chaque `{ model, as }` passe par
 *      `Model._getIncludedAssociation`, la fonction exacte de Sequelize qui
 *      lève « X is not associated to Y! ». Les includes imbriqués sont suivis ;
 *   2. COLONNES — `attributes`, `where` (y compris les clés assignées après
 *      coup : `where.statut = …`) et `order` désignent des attributs existants ;
 *   3. MIXINS — un appel `instance.getX()` / `addX()`… correspond à un
 *      accesseur généré par une association déclarée.
 *
 * Le code est lu par analyse syntaxique : les constantes, les spreads, les
 * ternaires et les fonctions locales qui retournent un littéral sont suivis.
 * Ce qui reste dynamique est rangé en « non vérifié » — ce n'est PAS une
 * erreur, seulement un angle mort signalé.
 *
 * Usage : `npm run audit:requetes`, ou `auditer()` depuis un test.
 */

const path = require('path');
const fs = require('fs');
const parser = require('@babel/parser');
const traverse = require('@babel/traverse').default;
const t = require('@babel/types');

const RACINE = path.resolve(__dirname, '..');
const SRC = path.join(RACINE, 'src');
const DOSSIER_MODELES = path.join(SRC, 'models');

/** Méthode de modèle → position de l'argument d'options. */
const INDEX_OPTIONS = {
  findAll: 0, findOne: 0, findAndCountAll: 0, count: 0, findOrCreate: 0, findCreateFind: 0,
  destroy: 0, reload: 0, findByPk: 1, update: 1, max: 1, min: 1, sum: 1, create: 1, bulkCreate: 1,
};

const MIXIN = /^(get|set|add|remove|has|count|create)[A-Z]\w*$/;

/**
 * Méthodes au format « getX / addX » qui ne sont PAS des mixins Sequelize :
 * JavaScript natif, Node (crypto, flux), ExcelJS. Une méthode de bibliothèque
 * signalée à tort s'ajoute ici.
 */
const HORS_SEQUELIZE = new Set([
  'getDataValue', 'setDataValue', 'getTableName', 'getAttributes', 'getAssociations', 'getQueryInterface',
  'getTime', 'getFullYear', 'getMonth', 'getDate', 'getDay', 'getHours', 'getMinutes', 'getSeconds',
  'getMilliseconds', 'getTimezoneOffset', 'getUTCFullYear', 'getUTCMonth', 'getUTCDate', 'getUTCDay',
  'getUTCHours', 'getUTCMinutes', 'getUTCSeconds', 'setHours', 'setDate', 'setMonth', 'setFullYear',
  'setMinutes', 'setSeconds', 'setMilliseconds', 'setUTCHours', 'setUTCDate', 'setTime',
  'hasOwnProperty', 'getOwnPropertyNames', 'getItem', 'setItem', 'setTimeout', 'setInterval',
  'setHeader', 'getHeader', 'hasHeader', 'removeHeader', 'removeListener', 'removeAllListeners',
  'setMaxListeners', 'setEncoding', 'setDefaultEncoding',
  'createHash', 'createHmac', 'createCipheriv', 'createDecipheriv', 'createSign', 'createVerify',
  'createPublicKey', 'createPrivateKey', 'getAuthTag', 'setAuthTag', 'setAAD',
  'createReadStream', 'createWriteStream', 'createServer', 'createClient', 'createTransport', 'getSignedUrl',
  // ExcelJS
  'addWorksheet', 'getWorksheet', 'removeWorksheet', 'addRow', 'addRows', 'getRow', 'getRows',
  'getCell', 'getColumn', 'addImage', 'addTable', 'addPage',
  // pdf-lib — incrustation des plans dans les rapports (rapportPlans.js)
  'getPage', 'getPages', 'getPageCount', 'getSize', 'getRotation', 'setRotation',
]);

const rel = (f) => path.relative(RACINE, f).replace(/\\/g, '/');
const estRequire = (n) => t.isCallExpression(n) && t.isIdentifier(n.callee, { name: 'require' });
const ignorerCle = (k) => typeof k !== 'string' || k.startsWith('$') || k.includes('.');
const cleDe = (p) => p.key?.name ?? p.key?.value;

function listerFichiers(dir, acc = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['__tests__', 'migrations', 'seeders', 'node_modules'].includes(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) listerFichiers(p, acc);
    else if (e.name.endsWith('.js')) acc.push(p);
  }
  return acc;
}

/**
 * @param {object} [options]
 * @param {string[]} [options.fichiers] — restreint l'audit à ces fichiers
 *   (chemins absolus) ; par défaut, tout `src/` hors tests et migrations.
 * @returns {{ fichiers: number, verifies: number, erreurs: string[],
 *   nonVerifies: string[], mixins: string[] }}
 */
function auditer({ fichiers: fichiersCibles } = {}) {
  const sequelize = require('../src/config/db.js');
  require('../src/models/index.js');
  const MODELS = new Set(Object.values(sequelize.models));

  const erreurs = new Set();
  const nonVerifies = new Set();
  const mixins = [];
  let verifies = 0;

  const nomModele = (M) => Object.entries(sequelize.models).find(([, v]) => v === M)?.[0] || M?.name;
  const colonneOk = (M, nom) => M.rawAttributes[nom]
    || Object.values(M.rawAttributes).some((a) => a.field === nom);
  const erreur = (loc, chemin, msg) => erreurs.add(`${loc}  [${chemin}]  ${msg}`);

  /** N'évalue que les fichiers de `src/models` : aucun effet de bord. */
  function charger(init, fichier) {
    const spec = init.arguments[0]?.value;
    if (typeof spec !== 'string' || !spec.startsWith('.')) return null;
    let abs;
    try { abs = require.resolve(path.resolve(path.dirname(fichier), spec)); } catch { return null; }
    if (!abs.startsWith(DOSSIER_MODELES)) return null;
    return require(abs);
  }

  /** Identifiant → modèle Sequelize réel, via le require qui l'a introduit. */
  function modeleDe(scope, node, fichier) {
    if (t.isMemberExpression(node) && t.isIdentifier(node.object, { name: 'models' }) && !node.computed) {
      return sequelize.models[node.property.name] || null;
    }
    if (!t.isIdentifier(node)) return null;
    const b = scope.getBinding(node.name);
    if (!b || !b.path.isVariableDeclarator()) return null;
    const { id, init } = b.path.node;
    let mod = null;
    if (estRequire(init)) mod = charger(init, fichier);
    else if (t.isMemberExpression(init) && estRequire(init.object)) {
      mod = charger(init.object, fichier)?.[init.property.name ?? init.property.value];
    } else return null;
    if (!mod) return null;
    if (t.isIdentifier(id)) return MODELS.has(mod) ? mod : null;
    if (t.isObjectPattern(id)) {
      const prop = id.properties.find((pr) => t.isObjectProperty(pr)
        && (pr.value === b.identifier || (t.isAssignmentPattern(pr.value) && pr.value.left === b.identifier)));
      const v = prop ? mod[cleDe(prop)] : null;
      return MODELS.has(v) ? v : null;
    }
    return null;
  }

  /** Suit les constantes et les fonctions locales qui RETOURNENT un littéral. */
  function resoudre(scope, node, prof = 0) {
    if (prof > 12 || !node) return [node, scope];
    if (t.isIdentifier(node)) {
      const b = scope.getBinding(node.name);
      if (b && b.path.isVariableDeclarator() && t.isIdentifier(b.path.node.id) && b.path.node.init
        && !estRequire(b.path.node.init)) {
        return resoudre(b.path.scope, b.path.node.init, prof + 1);
      }
      return [node, scope];
    }
    if (t.isCallExpression(node) && t.isIdentifier(node.callee)) {
      const b = scope.getBinding(node.callee.name);
      let fn = null;
      if (b?.path.isFunctionDeclaration()) fn = b.path;
      else if (b?.path.isVariableDeclarator()) {
        const initPath = b.path.get('init');
        if (initPath.isArrowFunctionExpression() || initPath.isFunctionExpression()) fn = initPath;
      }
      if (fn) {
        const body = fn.node.body;
        if (!t.isBlockStatement(body)) return resoudre(fn.scope, body, prof + 1);
        const ret = [...body.body].reverse().find((s) => t.isReturnStatement(s));
        if (ret) return resoudre(fn.scope, ret.argument, prof + 1);
      }
    }
    return [node, scope];
  }

  function verifierAttributs(M, val, loc, chemin) {
    let liste = null;
    if (t.isArrayExpression(val)) liste = val.elements;
    else if (t.isObjectExpression(val)) {
      const ex = val.properties.find((p) => t.isObjectProperty(p) && cleDe(p) === 'exclude');
      if (ex && t.isArrayExpression(ex.value)) liste = ex.value.elements;
    }
    for (const el of liste || []) {
      if (!t.isStringLiteral(el)) continue;
      verifies++;
      if (!ignorerCle(el.value) && !colonneOk(M, el.value)) {
        erreur(loc, chemin, `attribut « ${el.value} » absent du modèle ${nomModele(M)}`);
      }
    }
  }

  /** Clés posées après coup : `const ou = {…}; ou.statut = x;`. */
  function clesAssignees(scope, ident) {
    const b = scope.getBinding(ident.name);
    const cles = [];
    for (const r of b?.referencePaths || []) {
      const par = r.parentPath;
      if (par?.isMemberExpression() && par.node.object === r.node && !par.node.computed
        && par.parentPath?.isAssignmentExpression() && par.parentPath.node.left === par.node) {
        cles.push(par.node.property.name);
      }
    }
    return cles;
  }

  function verifierWhere(M, val, scope, loc, chemin, brut) {
    if (t.isIdentifier(brut)) {
      for (const k of clesAssignees(scope, brut)) {
        verifies++;
        if (!ignorerCle(k) && !colonneOk(M, k)) erreur(loc, chemin, `where.${k} (assigné) : colonne absente de ${nomModele(M)}`);
      }
    }
    if (t.isArrayExpression(val)) {
      for (const e of val.elements) { const [n, s] = resoudre(scope, e); verifierWhere(M, n, s, loc, chemin); }
      return;
    }
    if (!t.isObjectExpression(val)) return;
    for (const p of val.properties) {
      if (t.isSpreadElement(p)) { const [n, s] = resoudre(scope, p.argument); verifierWhere(M, n, s, loc, chemin, p.argument); continue; }
      if (!t.isObjectProperty(p)) continue;
      // Clé calculée ([Op.or], [Op.and]…) : on descend dans sa valeur.
      if (p.computed) { const [n, s] = resoudre(scope, p.value); verifierWhere(M, n, s, loc, chemin); continue; }
      const k = cleDe(p);
      verifies++;
      if (!ignorerCle(k) && !colonneOk(M, k)) erreur(loc, chemin, `where.${k} : colonne absente de ${nomModele(M)}`);
    }
  }

  function verifierOrder(M, val, loc, chemin) {
    if (!t.isArrayExpression(val)) return;
    for (const el of val.elements) {
      if (t.isStringLiteral(el)) {
        verifies++;
        if (!ignorerCle(el.value) && !colonneOk(M, el.value)) erreur(loc, chemin, `order « ${el.value} » absent de ${nomModele(M)}`);
        continue;
      }
      if (!t.isArrayExpression(el)) continue;
      const e = el.elements;
      if (e.length === 2 && t.isStringLiteral(e[0])) {
        verifies++;
        if (!ignorerCle(e[0].value) && !colonneOk(M, e[0].value)) erreur(loc, chemin, `order « ${e[0].value} » absent de ${nomModele(M)}`);
      } else if (e.length === 3 && t.isStringLiteral(e[0]) && t.isStringLiteral(e[1])) {
        verifies++;
        const a = M.associations[e[0].value];
        if (!a) erreur(loc, chemin, `order : association « ${e[0].value} » inconnue sur ${nomModele(M)}`);
        else if (!colonneOk(a.target, e[1].value)) erreur(loc, chemin, `order : « ${e[1].value} » absent de ${nomModele(a.target)}`);
      }
    }
  }

  function verifierIncludes(M, val, scope, loc, chemin, fichier) {
    const elements = [];
    const empiler = (n, s) => {
      const [r, rs] = resoudre(s, n);
      if (t.isArrayExpression(r)) {
        for (const e of r.elements) empiler(t.isSpreadElement(e) ? e.argument : e, rs);
      } else if (t.isConditionalExpression(r)) {
        // `peutVoir ? [{…}] : []` — les DEUX branches peuvent s'exécuter.
        empiler(r.consequent, rs);
        empiler(r.alternate, rs);
      } else if (t.isLogicalExpression(r)) {
        empiler(r.right, rs);
      } else if (r) elements.push([r, rs]);
    };
    empiler(val, scope);

    for (const [el, s] of elements) {
      let cible = null;
      let as;
      let objet = null;
      let aliasSeul = null;
      if (t.isObjectExpression(el)) {
        objet = el;
        const get = (k) => el.properties.find((p) => t.isObjectProperty(p) && !p.computed && cleDe(p) === k);
        if (get('all')) continue;
        const pm = get('model');
        const pa = get('as') || get('association');
        if (pa) {
          const [v] = resoudre(s, pa.value);
          if (!t.isStringLiteral(v)) { nonVerifies.add(`${loc}  [${chemin}]  alias dynamique`); continue; }
          as = v.value;
        }
        if (pm) {
          const [mn, ms] = resoudre(s, pm.value);
          cible = modeleDe(ms, mn, fichier) || modeleDe(s, pm.value, fichier);
          if (!cible) { nonVerifies.add(`${loc}  [${chemin}]  modèle d'include non résolu`); continue; }
        } else if (get('association')) aliasSeul = as;
        else { nonVerifies.add(`${loc}  [${chemin}]  include sans model`); continue; }
      } else if (t.isStringLiteral(el)) {
        aliasSeul = el.value;
      } else {
        cible = modeleDe(s, el, fichier);
        if (!cible) { nonVerifies.add(`${loc}  [${chemin}]  include non résolu`); continue; }
      }

      let assoc;
      verifies++;
      try {
        if (aliasSeul) {
          assoc = M.associations[aliasSeul];
          if (!assoc) throw new Error(`association « ${aliasSeul} » inconnue sur ${nomModele(M)}`);
        } else {
          assoc = M._getIncludedAssociation(cible, as);
        }
      } catch (e) {
        erreur(loc, chemin, `${nomModele(cible || M)} as '${as}' → ${e.message}`);
        continue;
      }
      if (objet) {
        verifierOptions(assoc.target, objet, s, loc, `${chemin} → ${nomModele(assoc.target)}(${assoc.as})`, fichier, assoc);
      }
    }
  }

  function verifierOptions(M, opts, scope, loc, chemin, fichier, assoc) {
    for (const p of opts.properties) {
      if (t.isSpreadElement(p)) {
        const [n, s] = resoudre(scope, p.argument);
        if (t.isObjectExpression(n)) verifierOptions(M, n, s, loc, chemin, fichier, assoc);
        continue;
      }
      if (!t.isObjectProperty(p) || p.computed) continue;
      const k = cleDe(p);
      const [v, vs] = resoudre(scope, p.value);
      if (k === 'attributes') verifierAttributs(M, v, loc, chemin);
      else if (k === 'where') verifierWhere(M, v, vs, loc, chemin, p.value);
      else if (k === 'include') verifierIncludes(M, p.value, scope, loc, chemin, fichier);
      else if (k === 'order') verifierOrder(M, v, loc, chemin);
      else if (k === 'through' && assoc?.through?.model && t.isObjectExpression(v)) {
        const at = v.properties.find((q) => t.isObjectProperty(q) && cleDe(q) === 'attributes');
        if (at) verifierAttributs(assoc.through.model, resoudre(vs, at.value)[0], loc, `${chemin} (through)`);
      }
    }
  }

  // ── Accesseurs générés par les associations (mixins) ────────────────────
  const ACCESSEURS = new Set();
  for (const M of MODELS) {
    for (const a of Object.values(M.associations)) {
      for (const acc of Object.values(a.accessors || {})) ACCESSEURS.add(acc);
    }
  }

  // ── Analyse ─────────────────────────────────────────────────────────────
  const liste = fichiersCibles || listerFichiers(SRC);
  const asts = [];
  const fonctionsDeclarees = new Set();
  for (const f of liste) {
    let ast;
    try {
      ast = parser.parse(fs.readFileSync(f, 'utf8'), {
        sourceType: 'unambiguous', errorRecovery: true,
        plugins: ['classProperties', 'classPrivateMethods', 'topLevelAwait'],
      });
    } catch (e) {
      nonVerifies.add(`${rel(f)} : analyse impossible (${e.message})`);
      continue;
    }
    asts.push([f, ast]);
    // Une méthode déclarée dans le code (`getStats`, `createInvoice`…) n'est
    // pas un mixin Sequelize : on la retire des candidats.
    traverse(ast, {
      'FunctionDeclaration|ClassMethod|ObjectMethod'(p) {
        const k = p.node.id?.name ?? p.node.key?.name;
        if (k) fonctionsDeclarees.add(k);
      },
      VariableDeclarator(p) { if (t.isIdentifier(p.node.id)) fonctionsDeclarees.add(p.node.id.name); },
      ObjectProperty(p) { if (!p.node.computed && t.isIdentifier(p.node.key)) fonctionsDeclarees.add(p.node.key.name); },
    });
  }

  for (const [f, ast] of asts) {
    traverse(ast, {
      CallExpression(p) {
        const callee = p.node.callee;
        if (!t.isMemberExpression(callee) || callee.computed || !t.isIdentifier(callee.property)) return;
        const meth = callee.property.name;
        const loc = `${rel(f)}:${p.node.loc.start.line}`;

        if (MIXIN.test(meth) && !HORS_SEQUELIZE.has(meth) && !ACCESSEURS.has(meth)
          && !fonctionsDeclarees.has(meth) && !modeleDe(p.scope, callee.object, f)) {
          mixins.push(`${loc}  .${meth}() : aucune association ne génère cet accesseur`);
        }

        if (!(meth in INDEX_OPTIONS)) return;
        let objet = callee.object;
        if (t.isCallExpression(objet) && t.isMemberExpression(objet.callee)
          && ['scope', 'unscoped', 'schema'].includes(objet.callee.property?.name)) {
          objet = objet.callee.object;
        }
        const argNode = p.node.arguments[INDEX_OPTIONS[meth]];
        if (!argNode) return;
        const [opts, os] = resoudre(p.scope, argNode);
        if (!t.isObjectExpression(opts)) return;
        const M = modeleDe(p.scope, objet, f);
        if (!M) {
          if (opts.properties.some((q) => t.isObjectProperty(q) && cleDe(q) === 'include')) {
            nonVerifies.add(`${loc}  ${meth}() sur un objet non résolu`);
          }
          return;
        }
        verifierOptions(M, opts, os, loc, nomModele(M), f, null);
      },
    });
  }

  return {
    fichiers: asts.length,
    verifies,
    erreurs: [...erreurs],
    nonVerifies: [...nonVerifies],
    mixins,
  };
}

module.exports = { auditer };

if (require.main === module) {
  const r = auditer();
  console.log(`\nAudit des requêtes — ${r.fichiers} fichiers, ${r.verifies} éléments vérifiés\n`);
  const section = (titre, lignes) => {
    console.log(`${titre} (${lignes.length})`);
    for (const l of lignes) console.log(`  ${l}`);
    console.log('');
  };
  section('ERREURS', r.erreurs);
  section('MIXINS SANS ASSOCIATION', r.mixins);
  section('NON VÉRIFIÉS (angles morts, pas des erreurs)', r.nonVerifies);
  process.exitCode = r.erreurs.length || r.mixins.length ? 1 : 0;
  require('../src/config/db.js').close();
}
