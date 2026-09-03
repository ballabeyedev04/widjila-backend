'use strict';

/**
 * Tests — le tableau de bord compte ce que l'utilisateur peut RÉELLEMENT voir.
 *
 * ## Ce qui s'était cassé
 *
 * Signalement terrain : l'écran d'accueil annonçait « 1 chantier » et la page
 * Chantiers restait vide. Les deux vues portaient pourtant sur le même
 * portefeuille — mais pas avec la même règle :
 *
 *   - `ChantierService.listChantiers` appliquait `_filtreCloisonnement` : hors
 *     rôles de GESTION, on ne voit que les chantiers sans demandeur, les
 *     siens, et ceux où l'on est explicitement affecté ;
 *   - `DashboardService.statsGlobales` comptait TOUTE l'organisation.
 *
 * Une entreprise lisait donc un compteur portant sur un chantier qu'elle
 * n'avait pas le droit d'ouvrir. Un chiffre qui annonce l'inatteignable passe
 * pour une panne de chargement — c'est exactement ainsi qu'il a été signalé.
 */

const ChantierService = require('../modules/chantier/service/chantier.service.js');

const auteur = (role, id = 'u1') => ({ id, role, organisationId: 'org-1' });

describe('filtreCloisonnement — qui voit quoi', () => {
  it('les rôles de GESTION voient tout : aucun filtre', () => {
    // Ce sont eux qui tranchent les demandes puis supervisent les chantiers
    // validés. Les cloisonner leur cacherait ce qu'ils doivent arbitrer.
    for (const role of ['ChefProjet', 'MaitreOuvrage']) {
      expect(ChantierService.filtreCloisonnement(auteur(role))).toBeNull();
    }
  });

  it('le super-admin plateforme voit tout', () => {
    expect(ChantierService.filtreCloisonnement(auteur('Admin'))).toBeNull();
  });

  it('une entreprise EST cloisonnée — c’est le cas du signalement', () => {
    const filtre = ChantierService.filtreCloisonnement(auteur('Entreprise'));

    expect(filtre).not.toBeNull();
    // Trois portes : chantier hors circuit, sa propre demande, ou affectation
    // explicite. Un chantier demandé par quelqu'un d'autre n'en franchit
    // aucune — d'où la liste vide.
    const alternatives = filtre[Object.getOwnPropertySymbols(filtre)[0]];
    expect(alternatives).toHaveLength(3);
  });

  it('un conducteur de travaux aussi', () => {
    expect(ChantierService.filtreCloisonnement(auteur('ConducteurTravaux'))).not.toBeNull();
  });

  it('sans auteur identifié, aucun filtre n’est fabriqué', () => {
    // Le cloisonnement s'appuie sur l'identité : sans elle, la clause
    // `demandeurId = <id>` n'aurait pas de sens. C'est au serveur d'exiger
    // l'authentification en amont, pas à ce filtre de la simuler.
    expect(ChantierService.filtreCloisonnement(null)).toBeNull();
    expect(ChantierService.filtreCloisonnement({})).toBeNull();
  });
});
