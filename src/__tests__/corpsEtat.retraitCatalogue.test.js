'use strict';

/**
 * Tests — le retrait de « Démolitions », « Maçonnerie » et « Couverture » du
 * catalogue standard des corps d'état.
 *
 * ## Pourquoi tester une migration
 *
 * Elle s'exécute une fois, sur une base de production, et n'a pas de seconde
 * chance : une clause `WHERE` trop large effacerait vingt-deux métiers que
 * personne n'a demandé de retirer, et la seule façon de s'en apercevoir serait
 * qu'un client ne retrouve plus « Plomberie » dans sa liste déroulante.
 *
 * On vérifie donc ce qu'on peut vérifier sans base : que le périmètre est
 * borné aux trois codes visés ET au catalogue de la plateforme, et que le
 * chemin destructeur est conditionné à l'absence d'usage.
 */

const fs = require('node:fs');
const path = require('node:path');

const CHEMIN = path.join(
  __dirname, '..', 'migrations',
  '20260907000002-retirer-corps-etat-demolitions-maconnerie-couverture.js'
);

const source = fs.readFileSync(CHEMIN, 'utf8');
const migration = require(CHEMIN);

describe('le périmètre du retrait', () => {
  it('ne vise que les trois codes demandés', () => {
    expect(source).toContain("const CODES = ['demolitions', 'maconnerie', 'couverture'];");
  });

  it('ne touche QUE le catalogue standard de la plateforme', () => {
    // `organisation_id IS NULL` = les lignes fournies par la plateforme. Une
    // organisation qui a créé SON propre « Couverture » le garde : c'est sa
    // donnée, et rien ne dit qu'elle veut la perdre.
    expect(source).toContain('c.organisation_id IS NULL');
    expect(source).toContain("UPDATE corps_etat SET actif = false");
    // Aucune écriture ne doit pouvoir partir sans l'un des deux filtres.
    for (const requete of source.split(/queryInterface\.sequelize\.query\(/).slice(1)) {
      const premiereInstruction = requete.slice(0, 400);
      if (/DELETE FROM corps_etat|UPDATE corps_etat/.test(premiereInstruction)) {
        expect(premiereInstruction).toMatch(/id IN \(:ids\)|organisation_id IS NULL/);
      }
    }
  });

  it('ne supprime physiquement que ce qui n’est référencé par AUCUNE réserve', () => {
    // `reserves.corps_etat_id` est en ON DELETE SET NULL : un DELETE ne
    // casserait rien, mais il effacerait le métier des réserves déjà
    // relevées — et « Démolitions » comme « Couverture » n'existent pas dans
    // l'ancien ENUM `reserves.categorie` qui sert de repli.
    expect(source).toContain('l.utilisations === 0');
    expect(source).toContain('l.utilisations > 0');
  });

  it('désactive plutôt que de soft-supprimer ce qui est encore utilisé', () => {
    // Le modèle est `paranoid` : une ligne soft-supprimée disparaîtrait AUSSI
    // des jointures qui affichent le métier d'une réserve existante. Le détail
    // d'une réserve « Couverture » n'afficherait plus aucun métier.
    expect(source).not.toContain('deleted_at = NOW()');
    expect(source).not.toContain('SET deleted_at');
  });
});

describe('le retour en arrière', () => {
  it('est réversible — `down` existe et recrée les trois métiers', () => {
    expect(typeof migration.down).toBe('function');
    for (const nom of ['Démolitions', 'Maçonnerie', 'Couverture']) {
      expect(source).toContain(nom);
    }
  });

  it('ne recrée pas un doublon si la ligne est encore là', () => {
    // Le chemin « désactivé » laisse la ligne en base : la réactiver suffit,
    // l'insérer une seconde fois créerait deux « Maçonnerie ».
    expect(source).toContain('WHERE NOT EXISTS');
  });
});

describe('la sortie du catalogue est complète', () => {
  it('les trois métiers ne sont plus servis par /corps-etat/actifs', () => {
    // `listerActifs` filtre sur `actif: true` et le modèle est `paranoid` :
    // les deux chemins de la migration — suppression ou désactivation —
    // ferment donc bien la liste déroulante du web ET du mobile.
    const service = fs.readFileSync(
      path.join(__dirname, '..', 'modules', 'corpsEtat', 'service', 'corpsEtat.service.js'),
      'utf8'
    );
    expect(service).toContain('actif: true');
  });
});
