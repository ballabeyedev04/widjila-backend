'use strict';

/**
 * Tests — le titulaire 'Entreprise' n'est oublié nulle part.
 *
 * ## Pourquoi ce fichier existe
 *
 * Le même défaut est revenu trois fois, sous trois visages différents :
 * l'entreprise ne pouvait pas payer son abonnement, ne voyait pas ses propres
 * paiements, ne voyait pas ses chantiers. À chaque fois la cause était la
 * même — un groupe de rôles écrit sans elle — et à chaque fois le symptôme
 * était un écran ou un bouton bien visible avec un 403 derrière.
 *
 * Le compte créé par l'inscription publique porte ce rôle
 * (auth.service.js#register). Il ouvre l'organisation, la paie, y invite ses
 * équipes : c'est le rôle le plus élevé après le super-admin plateforme.
 *
 * Ce fichier balaie donc TOUT : les groupes déclarés, et les gardes écrites en
 * clair dans les routes. Un oubli futur échoue ici, pas chez le client.
 *
 * ## Les deux exceptions, et pourquoi ce ne sont pas des oublis
 *
 * `VALIDATION_CHANTIER` — valider sa propre demande annulerait le circuit
 * voulu par le client : « n'importe qui qui crée le chantier sauf Admin reste
 * en attente ». L'entreprise dépose, un autre tranche.
 *
 * `SOUS_TRAITANT` — ce n'est pas un groupe de droits mais l'ouverture étroite
 * de deux routes au seul sous-traitant. L'y ajouter n'ouvrirait rien de plus à
 * l'entreprise, qui passe déjà par `RESERVE_INTERVENANTS`.
 */

const fs = require('fs');
const path = require('path');

const roles = require('../config/roles.js');

const TITULAIRE = 'Entreprise';

/** Groupes qui, délibérément, ne contiennent pas le titulaire. */
const EXCEPTIONS = new Set(['VALIDATION_CHANTIER', 'SOUS_TRAITANT']);

const MODULES = path.join(__dirname, '..', 'modules');

/** Tous les fichiers de route du projet. */
function fichiersDeRoute(racine = MODULES) {
  const trouves = [];
  for (const entree of fs.readdirSync(racine, { withFileTypes: true })) {
    const chemin = path.join(racine, entree.name);
    if (entree.isDirectory()) trouves.push(...fichiersDeRoute(chemin));
    else if (entree.name.endsWith('.route.js')) trouves.push(chemin);
  }
  return trouves;
}

describe('les groupes de rôles', () => {
  const groupes = Object.entries(roles).filter(([, v]) => Array.isArray(v));

  it('sont bien tous balayés — le test ne passe pas à vide', () => {
    expect(groupes.length).toBeGreaterThanOrEqual(9);
  });

  it.each(groupes.filter(([nom]) => !EXCEPTIONS.has(nom)).map(([nom]) => nom))(
    '%s contient le titulaire',
    (nom) => {
      expect(roles[nom]).toContain(TITULAIRE);
    }
  );

  it('VALIDATION_CHANTIER l’exclut, et c’est voulu', () => {
    expect(roles.VALIDATION_CHANTIER).not.toContain(TITULAIRE);
    // Mais quelqu'un doit pouvoir trancher : le super-admin plateforme.
    expect(roles.VALIDATION_CHANTIER).toContain('Admin');
  });

  it('aucun groupe ne perd les rôles qu’il couvrait déjà', () => {
    // Élargir ne doit RIEN retirer. Ces trois-là sont les piliers du produit.
    expect(roles.OPERATIONNEL).toContain('ChefProjet');
    expect(roles.GESTION).toContain('Admin');
    expect(roles.PILOTAGE).toContain('MaitreOuvrage');
  });
});

describe('les gardes écrites en clair dans les routes', () => {
  // `requireRole('X', 'Y')` — celles qui n'utilisent pas un groupe et
  // échappaient donc à toute revue d'ensemble.
  const APPEL = /requireRole\(\s*((?:'[A-Za-z]+'\s*,?\s*)+)\)/g;

  /** Les gardes littérales d'un fichier, chacune avec sa liste de rôles. */
  function gardesLitterales(source) {
    const trouvees = [];
    for (const m of source.matchAll(APPEL)) {
      trouvees.push(m[1].split(',').map((r) => r.trim().replace(/'/g, '')).filter(Boolean));
    }
    return trouvees;
  }

  it('il y en a bien à examiner', () => {
    const total = fichiersDeRoute()
      .reduce((n, f) => n + gardesLitterales(fs.readFileSync(f, 'utf8')).length, 0);

    expect(total).toBeGreaterThan(0);
  });

  it('chacune inclut le titulaire, ou ne concerne que la plateforme', () => {
    const manquantes = [];

    for (const fichier of fichiersDeRoute()) {
      const source = fs.readFileSync(fichier, 'utf8');
      for (const gardes of gardesLitterales(source)) {
        // `requireRole('Admin')` seul : route de la PLATEFORME. Elle n'a rien
        // à faire dans les mains d'une organisation cliente.
        const plateformeSeule = gardes.length === 1 && gardes[0] === 'Admin';
        if (plateformeSeule || gardes.includes(TITULAIRE)) continue;

        manquantes.push(`${path.basename(fichier)} : requireRole(${gardes.join(', ')})`);
      }
    }

    // Le message liste les coupables : sans cela, un échec obligerait à
    // relire toutes les routes pour retrouver laquelle a été oubliée.
    expect(manquantes).toEqual([]);
  });
});

describe('ce qui reste fermé au titulaire', () => {
  it('les routes de la plateforme le sont, et le restent', () => {
    // Valider les inscriptions, tarifer les formules, lire le journal d'audit
    // de toutes les organisations : ce n'est pas son affaire. Ces routes se
    // gardent par `requireRole('Admin')` en clair, jamais par un groupe.
    const dossier = path.join(MODULES, 'admin', 'route');
    const fichiers = fs.readdirSync(dossier).filter((f) => f.endsWith('.route.js'));

    expect(fichiers.length).toBeGreaterThanOrEqual(4);

    for (const fichier of fichiers) {
      const source = fs.readFileSync(path.join(dossier, fichier), 'utf8');

      expect({ fichier, gardee: source.includes("requireRole('Admin')") })
        .toEqual({ fichier, gardee: true });
      expect({ fichier, ouverteAuTitulaire: source.includes(`'${TITULAIRE}'`) })
        .toEqual({ fichier, ouverteAuTitulaire: false });
    }
  });
});
