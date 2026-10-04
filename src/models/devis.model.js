const { DataTypes } = require('sequelize');
const sequelize = require('../config/db.js');

/**
 * DEVIS d'abonnement — le parcours « Premium sur devis ».
 *
 * ── Pourquoi une table à part ─────────────────────────────────────────────
 *
 * Une formule du catalogue dont le prix est `null` est « sur devis » : il n'y
 * a pas de tarif public, il se négocie. Jusqu'ici ce parcours s'arrêtait à un
 * `mailto:` — le client écrivait, et l'abonnement était activé À LA MAIN par
 * le super-admin. Rien n'en gardait trace : ni le montant proposé, ni ce qui
 * avait été accepté, ni quand.
 *
 * Le devis est donc la pièce qui manque entre la demande et l'encaissement :
 * il porte le montant négocié, la durée, les limites contractuelles et les
 * conditions, et c'est LUI qui fait foi au moment d'activer. Trois objets
 * distincts, qu'on ne confond jamais (cahier des charges § 4) :
 *
 *   le DEVIS         — ce qui est proposé et accepté (cette table) ;
 *   le PAIEMENT      — ce que Stripe a encaissé (`abonnements_souscrits`
 *                      en attente, puis le webhook) ;
 *   l'ABONNEMENT     — le droit d'accès qui en découle (la même ligne, une
 *                      fois active).
 *
 * ── Le montant ne vient jamais du client ──────────────────────────────────
 *
 * Le client DEMANDE (ses besoins, son volume), il ne chiffre pas. Seul un
 * super-admin pose `montant_ht`, la durée et les limites. Le client accepte
 * ou refuse, et la session de paiement est construite à partir de ce qui est
 * écrit ici — jamais de ce que le navigateur envoie.
 *
 * ── Ce qui est figé ───────────────────────────────────────────────────────
 *
 * Montants, durée et limites sont recopiés sur la souscription au moment de
 * l'activation. Un devis modifié après coup ne réécrit donc pas un abonnement
 * déjà payé : l'historique reste une pièce comptable.
 */
const Devis = sequelize.define('Devis', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true
  },

  organisationId: {
    type: DataTypes.UUID,
    allowNull: false
  },

  /**
   * Numéro lisible et unique — `WDJ-2026-0001`.
   *
   * Reparti à 1 chaque année civile, comme une numérotation de devis
   * classique. Attribué par le service sous verrou (voir `devis.service.js`),
   * jamais par le client.
   */
  numero: {
    type: DataTypes.STRING(30),
    allowNull: false,
    unique: true
  },

  /**
   * Cycle de vie (cahier des charges § 4) :
   *
   *   brouillon — la demande du client est arrivée, rien n'est chiffré ;
   *   envoye    — le super-admin a chiffré et transmis : le client peut
   *               accepter ou refuser ;
   *   accepte   — accepté par le client : le paiement peut être engagé ;
   *   refuse    — refusé par le client, avec son motif ;
   *   expire    — la date de validité est passée sans acceptation.
   *
   * Un devis PAYÉ reste `accepte` : c'est la souscription qui porte l'état du
   * paiement. Confondre les deux reviendrait à perdre la trace de ce qui a
   * été accepté le jour où l'abonnement expire.
   */
  statut: {
    type: DataTypes.ENUM('brouillon', 'envoye', 'accepte', 'refuse', 'expire'),
    allowNull: false,
    defaultValue: 'brouillon'
  },

  /** Formule « sur devis » visée, telle qu'elle existait à la demande. */
  planAbonnementId: {
    type: DataTypes.UUID,
    allowNull: true
  },
  plan_code: {
    type: DataTypes.STRING(50),
    allowNull: true
  },
  plan_nom: {
    type: DataTypes.STRING(100),
    allowNull: true
  },

  // ── Chiffrage (posé par le super-admin) ───────────────────────────────
  //
  // `null` tant que le devis n'est pas chiffré : c'est ce qui distingue un
  // brouillon reçu d'un devis à 0 €.
  montant_ht: {
    type: DataTypes.DECIMAL(12, 2),
    allowNull: true
  },
  /** Taux en POURCENTAGE (20.00 = 20 %), 0 pour une facturation hors TVA. */
  taux_tva: {
    type: DataTypes.DECIMAL(5, 2),
    allowNull: false,
    defaultValue: 0
  },
  montant_tva: {
    type: DataTypes.DECIMAL(12, 2),
    allowNull: true
  },
  /** Ce qui sera RÉELLEMENT encaissé — c'est ce montant que Stripe débite. */
  montant_ttc: {
    type: DataTypes.DECIMAL(12, 2),
    allowNull: true
  },
  devise: {
    type: DataTypes.STRING(3),
    allowNull: false,
    defaultValue: 'EUR'
  },

  /**
   * Durée couverte, en mois. Un contrat sur devis ne tient pas toujours dans
   * « mois » ou « an » : 18 ou 36 mois sont courants en BTP.
   */
  duree_mois: {
    type: DataTypes.INTEGER,
    allowNull: true
  },

  /** `null` = illimité, jamais -1 (même convention que le catalogue). */
  limite_utilisateurs: {
    type: DataTypes.INTEGER,
    allowNull: true
  },
  limite_chantiers: {
    type: DataTypes.INTEGER,
    allowNull: true
  },

  /** Fonctionnalités comprises — CODES, comme le catalogue. `null` = toutes. */
  options: {
    type: DataTypes.JSONB,
    allowNull: true
  },

  /** Conditions particulières, telles qu'elles figureront sur le devis. */
  conditions: {
    type: DataTypes.TEXT,
    allowNull: true
  },

  // ── La demande du client, telle qu'il l'a saisie ──────────────────────
  //
  // Conservée BRUTE : c'est la pièce qui explique le chiffrage, et elle ne
  // doit pas se perdre si l'organisation change de nom ou de contact entre
  // la demande et la signature. Champs attendus : societe, siren, contact,
  // email, telephone, nbUtilisateurs, nbChantiers, dureeSouhaitee, besoins.
  demande: {
    type: DataTypes.JSONB,
    allowNull: true
  },
  /** Qui a demandé — pour lui répondre, et pour lui adresser le reçu. */
  demande_par: {
    type: DataTypes.UUID,
    allowNull: true
  },
  /** Quel super-admin a chiffré. */
  prepare_par: {
    type: DataTypes.UUID,
    allowNull: true
  },

  // ── Dates du cycle ────────────────────────────────────────────────────
  envoye_le: {
    type: DataTypes.DATE,
    allowNull: true
  },
  accepte_le: {
    type: DataTypes.DATE,
    allowNull: true
  },
  refuse_le: {
    type: DataTypes.DATE,
    allowNull: true
  },
  /**
   * Validité de l'offre. Passée cette date, le devis ne peut plus être ni
   * accepté ni payé — un prix négocié il y a six mois n'engage plus.
   */
  expire_le: {
    type: DataTypes.DATE,
    allowNull: true
  },
  /** Horodatage de l'encaissement confirmé par le webhook. */
  paye_le: {
    type: DataTypes.DATE,
    allowNull: true
  },

  motif_refus: {
    type: DataTypes.TEXT,
    allowNull: true
  },

  /** Souscription née de ce devis, une fois le paiement confirmé. */
  souscriptionId: {
    type: DataTypes.UUID,
    allowNull: true
  }
}, {
  tableName: 'devis',
  timestamps: true,
  underscored: true,
  indexes: [
    { fields: ['organisation_id'] },
    { fields: ['statut'] },
    { fields: ['organisation_id', 'statut'] },
    { unique: true, fields: ['numero'] }
  ]
});

module.exports = Devis;
