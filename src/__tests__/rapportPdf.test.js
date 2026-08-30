'use strict';

/**
 * Tests — modules/rapport/service/rapportPdf.js
 *
 * Le générateur est testé POUR DE VRAI : on construit un PDF complet en
 * mémoire et on vérifie son contenu. Un test qui se contenterait de vérifier
 * que la fonction ne lève pas laisserait passer exactement les défauts qui
 * comptent — une section vide, un « undefined » imprimé, une pagination
 * fausse.
 *
 * Ce qui est verrouillé ici :
 *   1. AUCUNE INVENTION — une donnée absente devient « Non renseigné », et le
 *      PDF ne contient jamais « undefined » ni « null » ;
 *   2. la numérotation d'origine des réserves est conservée ;
 *   3. toutes les sections attendues sont présentes ;
 *   4. la pagination « Page X / Y » est correcte et cohérente ;
 *   5. un volume réaliste ne fait pas tomber la génération.
 */

const zlib = require('node:zlib');
const {
  construireRapport, val, dateFr,
  LIBELLE_STATUT, LIBELLE_SEVERITE, LIBELLE_ROLE,
} = require('../modules/rapport/service/rapportPdf.js');

// Extraction du texte d’un PDF pdfkit — voir helpers/lireTextePdf.js pour
// la raison du détour (flux compressés, texte en héxadécimal).
const { lireTextePdf: texteDuPdf, lireTextePdfNormalise } = require('./helpers/lireTextePdf.js');

/**
 * Nombre réel de pages du document.
 *
 * Compté sur les objets `/Type /Page` — la seule mesure qui ne dépend ni de la
 * pagination imprimée ni de ce que pdfkit croit avoir produit. C'est ce qui
 * permet de détecter des pages blanches ajoutées à l'insu du générateur.
 */
function nombreDePages(buffer) {
  const bin = buffer.toString('latin1');
  return (bin.match(/\/Type\s*\/Page[^s]/g) || []).length;
}

/** Jeu de données minimal mais complet. */
function donnees(surcharge = {}) {
  return {
    titre: 'Rapport de chantier — Résidence Horizon',
    typeLibelle: 'opr',
    reference: 'RH-2026',
    dateRapport: new Date('2026-08-29T10:00:00Z'),
    auteur: 'Balla Beye',
    perimetre: 'Toutes les réserves du chantier',
    chantier: {
      nom: 'Résidence Horizon',
      code: 'RH-2026',
      adresse: '10 rue de la Paix, Paris',
      statut: 'en_cours',
      date_debut: '2026-01-05',
      date_fin: '2026-12-20',
    },
    organisation: { nom: 'Widjila BTP' },
    participants: [
      {
        nom: 'Jean Dupont', role: 'Chef de projet', fonction: 'Direction',
        email: 'jean@example.com', telephone: '0102030405', presence: 'Présent',
      },
    ],
    entreprises: [
      {
        lot: '6 - Électricité', entreprise: 'EGS', contact: 'Kemal Turk',
        adresse: '51 av. Aristide Briand', email: 'demo@example.com', telephone: '0143012806',
      },
    ],
    reserves: [],
    groupes: [],
    repartitionPhases: [{ phase: 'Pré-cloisons', total: 2 }],
    aTraiter: [],
    remarques: [{ titre: 'OPR — 29/08/2026', texte: 'Nettoyage à prévoir avant livraison.' }],
    pointsAVerifier: ['2 réserve(s) sans phase.'],
    nbPhotos: 0,
    ...surcharge,
  };
}

/** Réserve de test. */
function reserve(n, surcharge = {}) {
  return {
    id: `r${n}`,
    numero: `R-${String(n).padStart(4, '0')}`,
    titre: `Défaut ${n}`,
    description: `Description du défaut ${n}.`,
    statut: 'en_cours',
    severite: 'haute',
    createdAt: new Date('2026-08-01T08:00:00Z'),
    date_limite: '2026-09-15',
    date_validation: null,
    localisation: 'Bâtiment A › R+2 › A203',
    lot: '6 - Électricité',
    entreprise: 'EGS',
    phase: 'Pré-cloisons',
    photos: [],
    planId: 'p1',
    plan: { nom: 'AAL-PER-PRO-PLN-01' },
    ...surcharge,
  };
}

/** Regroupe des réserves comme le fait le service. */
const enGroupes = (reserves, libelle = 'Plan AAL-PER-PRO-PLN-01') => [{ libelle, reserves }];

describe('helpers — la règle « aucune invention »', () => {
  it('remplace toute donnée absente par un libellé explicite', () => {
    // Une case vide se lit comme un défaut de mise en page ; un libellé se lit
    // comme une information manquante à la source. La nuance compte sur un
    // document contradictoire.
    expect(val(null)).toBe('Non renseigné');
    expect(val(undefined)).toBe('Non renseigné');
    expect(val('')).toBe('Non renseigné');
    expect(val('   ')).toBe('Non renseigné');
    expect(val(0)).toBe('0');
    expect(val('Peinture')).toBe('Peinture');
  });

  it('n’invente jamais de date', () => {
    expect(dateFr(null)).toBe('Non renseigné');
    expect(dateFr('pas-une-date')).toBe('Non renseigné');
    expect(dateFr('2026-09-15')).toBe('15/09/2026');
  });

  it('couvre tous les statuts et sévérités de la base', () => {
    // Un statut sans libellé s'imprimerait en brut (« a_verifier ») dans un
    // document envoyé au client.
    const statuts = ['creee', 'affectee', 'prise_en_charge', 'en_cours', 'corrigee',
      'a_verifier', 'validee', 'refusee', 'rouverte', 'en_retard', 'cloturee'];
    for (const s of statuts) expect(LIBELLE_STATUT[s]).toBeDefined();

    for (const s of ['faible', 'moyenne', 'haute', 'critique']) {
      expect(LIBELLE_SEVERITE[s]).toBeDefined();
    }
    for (const r of ['ChefProjet', 'ConducteurTravaux', 'BureauControle', 'MaitreOuvrage',
      'MaitreOeuvre', 'Entreprise', 'Client', 'Pilote', 'SousTraitant']) {
      expect(LIBELLE_ROLE[r]).toBeDefined();
    }
  });
});

describe('génération du document', () => {
  it('produit un PDF valide', async () => {
    const buffer = await construireRapport(donnees());

    expect(Buffer.isBuffer(buffer)).toBe(true);
    expect(buffer.subarray(0, 5).toString()).toBe('%PDF-');
    expect(buffer.length).toBeGreaterThan(1000);
  });

  it('imprime toutes les sections attendues', async () => {
    const reserves = [reserve(1), reserve(2)];
    const pdfBuffer = await construireRapport(donnees({
      reserves,
      groupes: enGroupes(reserves),
      aTraiter: [{
        numero: 'R-0001', titre: 'Défaut 1', localisation: 'Bâtiment A',
        entreprise: 'EGS', echeance: '15/09/2026', statut: 'en_cours', statutLibelle: 'En cours',
      }],
    }));
    // Comparaison sans accents : l'extraction restitue du WinAnsi, que l'on ne
    // peut pas comparer tel quel à un littéral JavaScript accentué.
    const sansAccent = lireTextePdfNormalise(pdfBuffer);

    for (const section of [
      'INFORMATIONS SUR LE PROJET',
      'PARTICIPANTS',
      'ENTREPRISES ET INTERVENANTS',
      'SYNTHESE',
      'RESERVES ET OBSERVATIONS',
      'RESERVES A TRAITER',
      'REMARQUES GENERALES',
      'POINTS NECESSITANT UNE VERIFICATION',
      'SOURCES ET PERIMETRE',
    ]) {
      expect(sansAccent).toContain(section);
    }
  });

  it('reprend les informations du projet et des intervenants', async () => {
    const texte = texteDuPdf(await construireRapport(donnees()));

    expect(texte).toContain('Résidence Horizon');
    expect(texte).toContain('10 rue de la Paix, Paris');
    expect(texte).toContain('Jean Dupont');
    expect(texte).toContain('EGS');
    expect(texte).toContain('6 - Électricité');
    expect(texte).toContain('Widjila BTP');
  });

  it('CONSERVE la numérotation d’origine des réserves', async () => {
    // Renuméroter romprait le lien avec l'application, le mobile et les
    // échanges déjà faits avec les entreprises.
    const reserves = [reserve(7), reserve(42)];
    const texte = texteDuPdf(await construireRapport(donnees({
      reserves, groupes: enGroupes(reserves),
    })));

    expect(texte).toContain('R-0007');
    expect(texte).toContain('R-0042');
    // Aucune renumérotation en 1, 2…
    expect(texte).not.toContain('R-0001');
  });

  it('n’imprime jamais « undefined » ni « null »', async () => {
    // Le piège classique d'un template : une donnée absente traverse la mise
    // en page et s'imprime telle quelle sur un document envoyé au client.
    const nue = reserve(1, {
      description: null, date_limite: null, date_validation: null,
      localisation: 'Non renseigné', lot: 'Non renseigné',
      entreprise: 'Non renseigné', phase: 'Non renseigné', plan: null, planId: null,
    });
    const texte = texteDuPdf(await construireRapport(donnees({
      reserves: [nue],
      groupes: enGroupes([nue], 'Sans localisation'),
      chantier: { nom: 'Chantier X' }, // adresse, code, dates absents
      organisation: null,
      participants: [],
      entreprises: [],
      remarques: [],
      pointsAVerifier: [],
    })));

    expect(texte).not.toMatch(/undefined/i);
    expect(texte).not.toMatch(/\bnull\b/i);
    expect(texte).toContain('Non renseigné');
  });

  it('annonce clairement les sections vides plutôt que de les taire', async () => {
    const texte = texteDuPdf(await construireRapport(donnees({
      participants: [], entreprises: [], reserves: [], groupes: [],
    })));

    expect(texte).toContain('Aucun participant');
    expect(texte).toContain('Aucune entreprise');
    expect(texte).toContain('Aucune réserve');
  });
});

describe('pagination', () => {
  it('numérote chaque page « Page X / Y » avec le bon total', async () => {
    // Assez de réserves pour dépasser plusieurs pages.
    const reserves = Array.from({ length: 40 }, (_, i) => reserve(i + 1));
    const buffer = await construireRapport(donnees({
      reserves, groupes: enGroupes(reserves),
    }));
    const texte = texteDuPdf(buffer);

    const pages = [...texte.matchAll(/Page (\d+) \/ (\d+)/g)];
    expect(pages.length).toBeGreaterThan(1);

    const total = Number(pages[0][2]);
    // Le total est le même partout, et chaque page porte son propre numéro,
    // dans l'ordre : c'est ce qui rend le document imprimable et vérifiable.
    expect(pages.every((p) => Number(p[2]) === total)).toBe(true);
    expect(pages.map((p) => Number(p[1]))).toEqual(
      Array.from({ length: pages.length }, (_, i) => i + 1)
    );
    expect(total).toBe(pages.length);

    // Le document doit contenir EXACTEMENT ce nombre de pages.
    //
    // Sans cette vérification, le défaut suivant passait inaperçu : écrire le
    // pied de page sous la marge basse faisait ajouter une page à pdfkit à
    // chaque pied posé. Le document annonçait « Page 1 / 7 » — sept pieds,
    // sept numéros cohérents — mais comptait 28 pages, dont 21 blanches.
    expect(nombreDePages(buffer)).toBe(total);
  });

  it('n’ajoute aucune page blanche sur un document court', async () => {
    const buffer = await construireRapport(donnees());
    const texte = texteDuPdf(buffer);
    const total = Number((texte.match(/Page \d+ \/ (\d+)/) || [])[1]);

    expect(nombreDePages(buffer)).toBe(total);
  });
});

describe('robustesse', () => {
  it('tient un volume réaliste de réserves', async () => {
    const reserves = Array.from({ length: 150 }, (_, i) => reserve(i + 1));
    const buffer = await construireRapport(donnees({
      reserves,
      groupes: [
        { libelle: 'Plan PLN-01', reserves: reserves.slice(0, 75) },
        { libelle: 'Plan PLN-02', reserves: reserves.slice(75) },
      ],
    }));

    expect(buffer.subarray(0, 5).toString()).toBe('%PDF-');
  }, 30000);

  it('ne tombe pas sur une photo illisible', async () => {
    // Un octet quelconque n'est pas une image : pdfkit lève, et le rapport
    // doit malgré tout se terminer — une vignette manquante ne justifie pas
    // de perdre tout le document.
    const avecPhotoCassee = reserve(1, { photos: [Buffer.from('pas une image')] });
    const buffer = await construireRapport(donnees({
      reserves: [avecPhotoCassee],
      groupes: enGroupes([avecPhotoCassee]),
    }));

    expect(buffer.subarray(0, 5).toString()).toBe('%PDF-');
    expect(texteDuPdf(buffer)).toContain('Photo illisible');
  });

  it('accepte un rapport entièrement vide sans lever', async () => {
    const buffer = await construireRapport({
      reserves: [], groupes: [], participants: [], entreprises: [],
      repartitionPhases: [], aTraiter: [], remarques: [], pointsAVerifier: [],
      nbPhotos: 0,
    });

    expect(buffer.subarray(0, 5).toString()).toBe('%PDF-');
  });
});
