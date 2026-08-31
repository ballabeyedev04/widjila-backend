'use strict';

/**
 * Tests — identifiants d'entreprise selon le pays.
 *
 * Le formulaire d'inscription proposait SIRET, RCCM et NINEA à tout le monde.
 * Une entreprise française se voyait donc demander un NINEA — identifiant
 * sénégalais — et une entreprise malienne n'avait nulle part où saisir son NIF.
 *
 * Ce qui doit être verrouillé :
 *
 *   1. chaque pays n'accepte QUE ses propres identifiants ;
 *   2. un identifiant hors sujet est REFUSÉ, pas ignoré en silence — une
 *      donnée acceptée puis jetée fait croire qu'elle est enregistrée ;
 *   3. aucun identifiant n'est obligatoire : une entreprise en cours
 *      d'immatriculation doit pouvoir s'inscrire ;
 *   4. un code pays inconnu est refusé — sans champs associés, l'inscription
 *      passerait sans qu'aucun identifiant ne soit vérifié.
 */

const { registerSchema } = require('../modules/auth/validation/auth.validation.js');
const { champsDuPays, PAYS } = require('../config/pays.js');

/** Inscription minimale valide, à laquelle on ajoute les champs testés. */
const base = (extra = {}) => ({
  nom: 'Beye',
  prenom: 'Balla',
  email: 'contact@exemple.com',
  mot_de_passe: 'MotDePasse1',
  ...extra,
});

const valider = (donnees) => registerSchema.validate(donnees, { abortEarly: true });

describe('France', () => {
  it('accepte un SIRET et un numéro de TVA', () => {
    const { error } = valider(base({
      organisationPays: 'FR',
      siret: '12345678901234',
      num_tva: 'FR12345678901',
    }));
    expect(error).toBeUndefined();
  });

  it('REFUSE un NINEA — c’est un identifiant sénégalais', () => {
    const { error } = valider(base({ organisationPays: 'FR', ninea: 'SN123456' }));

    expect(error).toBeDefined();
    expect(error.message).toContain('NINEA');
    // Sans l'apostrophe : elle est typographique dans le message, droite
    // dans ce fichier, et cette differences ne dit rien du comportement.
    expect(error.message).toContain('applique pas');
  });

  it('refuse un SIRET qui n’a pas 14 chiffres', () => {
    const { error } = valider(base({ organisationPays: 'FR', siret: '123' }));

    expect(error).toBeDefined();
    expect(error.message).toContain('SIRET');
  });
});

describe('Sénégal', () => {
  it('accepte NINEA et RCCM', () => {
    const { error } = valider(base({
      organisationPays: 'SN',
      ninea: 'SN0123456',
      rccm: 'SN-DKR-2024-B-1234',
    }));
    expect(error).toBeUndefined();
  });

  it('refuse un SIRET', () => {
    const { error } = valider(base({ organisationPays: 'SN', siret: '12345678901234' }));
    expect(error.message).toContain('SIRET');
  });
});

describe('Mali', () => {
  it('accepte NIF et RCCM', () => {
    const { error } = valider(base({
      organisationPays: 'ML',
      nif: 'ML0123456789',
      rccm: 'ML-BKO-2024-B-999',
    }));
    expect(error).toBeUndefined();
  });

  it('refuse un NINEA', () => {
    const { error } = valider(base({ organisationPays: 'ML', ninea: 'SN0123456' }));
    expect(error.message).toContain('NINEA');
  });
});

describe('Côte d’Ivoire', () => {
  it('accepte les TROIS identifiants ensemble', () => {
    // L'IDU a vocation à remplacer RCCM et NCC, mais les deux systèmes
    // coexistent : refuser la combinaison bloquerait des entreprises qui
    // possèdent légitimement les trois numéros.
    const { error } = valider(base({
      organisationPays: 'CI',
      rccm: 'CI-ABJ-2024-B-1234',
      ncc: 'CI0123456A',
      idu: 'CI12345678901A',
    }));
    expect(error).toBeUndefined();
  });

  it('refuse un SIRET', () => {
    const { error } = valider(base({ organisationPays: 'CI', siret: '12345678901234' }));
    expect(error.message).toContain('SIRET');
  });
});

describe('règles générales', () => {
  it('aucun identifiant n’est obligatoire', () => {
    // Une entreprise en cours d'immatriculation n'a pas encore ses numéros.
    for (const p of PAYS) {
      const { error } = valider(base({ organisationPays: p.code }));
      expect(error).toBeUndefined();
    }
  });

  it('une chaîne vide n’est pas traitée comme une valeur', () => {
    // Les formulaires envoient '' pour un champ non rempli : le traiter comme
    // une saisie ferait échouer toutes les inscriptions partielles.
    const { error } = valider(base({ organisationPays: 'FR', ninea: '', rccm: '' }));
    expect(error).toBeUndefined();
  });

  it('refuse un code pays inconnu', () => {
    const { error } = valider(base({ organisationPays: 'ZZ' }));
    expect(error).toBeDefined();
  });

  it('sans pays, aucune vérification croisée n’est faite', () => {
    // Le pays reste facultatif : une inscription sans pays doit passer, quitte
    // à ce que l'identifiant soit vérifié plus tard.
    const { error } = valider(base({ ninea: 'SN0123456' }));
    expect(error).toBeUndefined();
  });
});

describe('catalogue des pays', () => {
  it('chaque pays déclare au moins un identifiant', () => {
    for (const p of PAYS) {
      expect(champsDuPays(p.code).length).toBeGreaterThan(0);
    }
  });

  it('un pays inconnu ne rend AUCUN champ', () => {
    // Rendre la liste complète ferait tout accepter sur une valeur qu'on ne
    // reconnaît pas — l'inverse de ce qu'on veut.
    expect(champsDuPays('ZZ')).toEqual([]);
  });

  it('RCCM est partagé par les trois pays OHADA', () => {
    for (const code of ['SN', 'ML', 'CI']) {
      expect(champsDuPays(code)).toContain('rccm');
    }
    expect(champsDuPays('FR')).not.toContain('rccm');
  });
});
