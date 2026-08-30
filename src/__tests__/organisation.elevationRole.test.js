'use strict';

/**
 * Tests — garde d'élévation de privilège sur la gestion des membres.
 *
 * `GESTION_MEMBRES` ouvre `/organisation/membres` au rôle `Entreprise`, pour
 * la parité avec le mobile. Bloquer le seul rôle `Admin` ne suffit alors plus :
 * une entreprise pouvait se créer un compte `ChefProjet`, en choisir le mot de
 * passe, s'y connecter — et obtenir les réglages de l'organisation, les
 * filiales et les équipes, dont `roles.js` dit qu'elle n'a rien à y faire.
 *
 * Ce qui doit être verrouillé :
 *
 *   1. un appelant HORS gestion ne peut attribuer aucun rôle de GESTION,
 *      ni à la création ni à la modification ;
 *   2. il garde le droit d'ajouter ses propres exécutants — sinon la
 *      fonctionnalité demandée n'existe plus ;
 *   3. un appelant DÉJÀ dans GESTION n'est pas restreint : attribuer un rôle
 *      de gestion quand on en a un n'est pas une élévation (non-régression).
 */

const OrganisationService = require('../modules/organisation/service/organisation.service.js');

describe('_refusElevation', () => {
  describe('appelant hors gestion (Entreprise)', () => {
    it.each(['ChefProjet', 'MaitreOuvrage', 'Admin'])(
      'refuse d’attribuer le rôle %s',
      (role) => {
        // `Admin` n'est pas dans GESTION côté « rôle visé » pour tous les
        // chemins, mais il l'est bien dans la liste : la garde le couvre
        // aussi, en plus du refus explicite déjà présent.
        const refus = OrganisationService._refusElevation('Entreprise', role);
        if (role === 'Admin') {
          // `Admin` figure dans GESTION : il est refusé par cette garde-ci.
          expect(refus).not.toBeNull();
        } else {
          expect(refus).not.toBeNull();
          expect(refus.success).toBe(false);
          expect(refus.message).toContain('gestion');
        }
      }
    );

    it.each(['ConducteurTravaux', 'BureauControle', 'MaitreOeuvre', 'Entreprise', 'Client', 'Pilote', 'SousTraitant'])(
      'laisse attribuer le rôle %s',
      (role) => {
        // Sans cela, la fonctionnalité demandée — une entreprise constitue son
        // propre effectif — n'existerait plus.
        expect(OrganisationService._refusElevation('Entreprise', role)).toBeNull();
      }
    );
  });

  describe('appelant déjà dans GESTION', () => {
    it.each(['Admin', 'ChefProjet', 'MaitreOuvrage'])(
      '%s peut attribuer un rôle de gestion',
      (roleAuteur) => {
        expect(OrganisationService._refusElevation(roleAuteur, 'ChefProjet')).toBeNull();
        expect(OrganisationService._refusElevation(roleAuteur, 'MaitreOuvrage')).toBeNull();
      }
    );
  });

  it('ne dit rien quand aucun rôle n’est visé', () => {
    // Une modification qui ne touche pas au rôle (changer un téléphone) ne
    // doit pas se mettre à échouer.
    expect(OrganisationService._refusElevation('Entreprise', undefined)).toBeNull();
    expect(OrganisationService._refusElevation('Entreprise', null)).toBeNull();
  });
});
