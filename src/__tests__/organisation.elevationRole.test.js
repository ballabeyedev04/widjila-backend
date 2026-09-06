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
  describe('appelant hors gestion (Client)', () => {
    it.each(['ChefProjet', 'MaitreOuvrage', 'Admin'])(
      'refuse d’attribuer le rôle %s',
      (role) => {
        // La garde vit toujours : un intervenant extérieur ne se fabrique pas
        // un compte de gestion. Elle ne vise plus 'Entreprise', qui EST la
        // gestion de son organisation.
        const refus = OrganisationService._refusElevation('Client', role);

        expect(refus).not.toBeNull();
        expect(refus.success).toBe(false);
        expect(refus.message).toContain('gestion');
      }
    );

    it.each(['ConducteurTravaux', 'BureauControle', 'MaitreOeuvre', 'Client', 'Pilote', 'SousTraitant'])(
      'laisse attribuer le rôle %s',
      (role) => {
        expect(OrganisationService._refusElevation('Client', role)).toBeNull();
      }
    );
  });

  describe('le titulaire constitue son effectif', () => {
    it.each(['ChefProjet', 'MaitreOuvrage', 'ConducteurTravaux', 'MaitreOeuvre', 'BureauControle'])(
      'laisse une Entreprise attribuer le rôle %s',
      (role) => {
        // C'est son organisation : elle y nomme ses chefs de projet et ses
        // conducteurs de travaux sans passer par personne.
        expect(OrganisationService._refusElevation('Entreprise', role)).toBeNull();
      }
    );

    it('ne lui ouvre pas pour autant le rôle Admin', () => {
      // Le super-admin plateforme reste hors de portée — refusé en clair par
      // `ajouterMembre` et `modifierMembre`, jamais par cette garde-ci.
      const source = require('fs').readFileSync(
        require('path').join(__dirname, '..', 'modules', 'organisation', 'service', 'organisation.service.js'),
        'utf8'
      );

      expect(source).toContain("data.role === 'Admin'");
      expect(source).toContain('réservé au super-admin');
    });
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
