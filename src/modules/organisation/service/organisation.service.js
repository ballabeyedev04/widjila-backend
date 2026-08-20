'use strict';

const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { Op } = require('sequelize');
const { Utilisateur, Organisation, Equipe } = require('../../../models/index.js');
const { bcryptConfig } = require('../../../config/security.js');
const { storeFile } = require('../../../infrastructure/storage.service.js');
const logger = require('../../../utils/logger.js');
const formatUser = require('../../../utils/formatUser.js');
const { SAFE_USER_ATTRIBUTES } = formatUser;
const escapeLike = require('../../../utils/escapeLike.js');
const { GESTION } = require('../../../config/roles.js');

// Rôles autorisés pour les contacts importés (jamais 'Admin')
const ROLES_IMPORT = ['ChefProjet', 'ConducteurTravaux', 'BureauControle', 'Entreprise', 'Client', 'MaitreOuvrage', 'MaitreOeuvre', 'Pilote', 'SousTraitant'];

// Rôles qu'un membre peut attribuer/modifier au sein de son organisation
// (le rôle 'Admin' = super-admin plateforme, jamais assignable ici).
const ROLES_ORGANISATION = ['ChefProjet', 'ConducteurTravaux', 'BureauControle', 'Entreprise', 'Client', 'MaitreOuvrage', 'MaitreOeuvre', 'Pilote', 'SousTraitant'];

class OrganisationService {

  // -------------------- ORGANISATION COURANTE --------------------
  /**
   * L'annuaire (nom, prénom, EMAIL, rôle de chaque membre) n'est joint que pour
   * les rôles de gestion. La route GET /organisation est ouverte à tous les
   * membres, y compris Client et Entreprise — des tiers externes à qui le
   * cahier des charges n'accorde qu'un suivi en lecture. Sans ce filtre, un
   * client invité sur un seul chantier récupérait l'annuaire interne complet.
   */
  static async getOrganisation(organisationId, role = null) {
    const peutVoirAnnuaire = role === 'Admin' || GESTION.includes(role);

    const organisation = await Organisation.findByPk(organisationId, {
      include: peutVoirAnnuaire
        ? [{ model: Utilisateur, as: 'membres', attributes: ['id', 'nom', 'prenom', 'email', 'role', 'statut', 'photoProfil'] }]
        : [],
    });
    if (!organisation) return { success: false, message: 'Organisation introuvable' };
    return { success: true, organisation };
  }

  // -------------------- MODIFIER L'ORGANISATION --------------------
  static async modifierOrganisation(organisationId, data, files = {}) {
    const organisation = await Organisation.findByPk(organisationId);
    if (!organisation) return { success: false, message: 'Organisation introuvable' };

    if (data.siret && data.siret !== organisation.siret) {
      const exist = await Organisation.findOne({ where: { siret: data.siret } });
      if (exist) return { success: false, message: 'Ce SIRET est déjà utilisé par une autre organisation' };
    }

    const updates = {};
    for (const champ of ['nom', 'raison_sociale', 'siret', 'num_tva', 'rccm', 'ninea', 'telephone', 'email', 'adresse', 'ville', 'pays', 'abonnement']) {
      if (data[champ] !== undefined) updates[champ] = data[champ];
    }
    if (updates.email) updates.email = updates.email.toLowerCase();

    if (files.logo && files.logo[0]) {
      updates.logo_url = await storeFile(files.logo[0].buffer, files.logo[0].originalname, 'organisations');
    }

    await organisation.update(updates);
    return { success: true, message: 'Organisation mise à jour avec succès', organisation };
  }

  // -------------------- MEMBRES --------------------
  static async listMembres(organisationId, { page = 1, limit = 20, search = '', role, statut } = {}) {
    const where = { organisationId };
    if (search) {
      const motif = `%${escapeLike(search)}%`;
      where[Op.or] = [
        { nom: { [Op.iLike]: motif } },
        { prenom: { [Op.iLike]: motif } },
        { email: { [Op.iLike]: motif } },
      ];
    }
    // Filtres de la barre d'outils « Membres » — alignés sur les autres
    // services de liste (gestionUtilisateur, gestionOrganisation).
    if (role) where.role = role;
    if (statut) where.statut = statut;

    const { rows, count } = await Utilisateur.findAndCountAll({
      where,
      // Uniquement des attributs sûrs — JAMAIS mfa_secret, tentatives_connexion
      // ni compte_bloque_jusqua (fuite critique corrigée, cf. audit).
      attributes: SAFE_USER_ATTRIBUTES,
      order: [['createdAt', 'DESC']],
      limit,
      offset: (page - 1) * limit,
    });

    return { success: true, membres: rows, total: count };
  }

  /**
   * Ajoute un membre à l'organisation.
   * Sans mot_de_passe fourni → mot de passe temporaire généré et renvoyé
   * une seule fois (l'utilisateur devra le changer à la première connexion).
   */
  static async ajouterMembre(organisationId, data) {
    if (data.role === 'Admin') {
      return { success: false, message: "Le rôle 'Admin' est réservé au super-admin de la plateforme" };
    }

    const emailClean = data.email.trim().toLowerCase();

    const exist = await Utilisateur.findOne({ where: { email: emailClean } });
    if (exist) return { success: false, message: 'Un compte existe déjà avec cet email' };

    if (data.telephone) {
      const telExist = await Utilisateur.findOne({ where: { telephone: data.telephone } });
      if (telExist) return { success: false, message: 'Ce numéro de téléphone est déjà utilisé' };
    }

    // Mot de passe temporaire si non fourni — marqué pour rotation au 1er login
    let motDePasse = data.mot_de_passe;
    let motDePasseTemporaire = null;
    let mdpTemporaire = false;
    if (!motDePasse) {
      motDePasseTemporaire = crypto.randomBytes(6).toString('hex');
      motDePasse = motDePasseTemporaire;
      mdpTemporaire = true;
    }

    const utilisateur = await Utilisateur.create({
      organisationId,
      nom: data.nom,
      prenom: data.prenom,
      email: emailClean,
      mot_de_passe: await bcrypt.hash(motDePasse, bcryptConfig.saltRounds),
      telephone: data.telephone || null,
      fonction: data.fonction || null,
      role: data.role,
      permissions: data.permissions || null,
      statut: 'actif',
      mdp_temporaire: mdpTemporaire,
      email_verifie: true, // invité par un acteur de confiance de l'organisation
    });

    logger.info(`Membre ajouté à l'organisation ${organisationId} : ${emailClean}`);

    return {
      success: true,
      message: 'Membre ajouté avec succès',
      utilisateur,
      motDePasseTemporaire, // renvoyé une seule fois
    };
  }

  /**
   * Modifie un membre de l'organisation.
   * Sécurité (audit C1) : impossible d'assigner le rôle 'Admin' (réservé au
   * super-admin), impossible de modifier son propre rôle/statut/permissions
   * (anti auto-promotion), et les rôles sont limités à la liste organisation.
   */
  static async modifierMembre(organisationId, membreId, data, acteurId = null) {
    const utilisateur = await Utilisateur.findOne({
      where: { id: membreId, organisationId },
    });
    if (!utilisateur) return { success: false, message: 'Membre introuvable dans cette organisation' };

    // Anti auto-promotion : on ne modifie pas son propre rôle, statut ou permissions
    if (acteurId && String(acteurId) === String(membreId)) {
      const champsSensibles = ['role', 'statut', 'permissions'];
      if (champsSensibles.some((c) => data[c] !== undefined)) {
        return {
          success: false,
          message: 'Vous ne pouvez pas modifier votre propre rôle, statut ou permissions',
        };
      }
    }

    // Le rôle 'Admin' (super-admin plateforme) n'est jamais assignable ici
    if (data.role !== undefined && (data.role === 'Admin' || !ROLES_ORGANISATION.includes(data.role))) {
      return { success: false, message: 'Rôle invalide : seul le super-admin de la plateforme a le rôle Admin' };
    }

    if (data.telephone && data.telephone !== utilisateur.telephone) {
      const telExist = await Utilisateur.findOne({ where: { telephone: data.telephone } });
      if (telExist) return { success: false, message: 'Ce numéro de téléphone est déjà utilisé' };
    }

    const updates = {};
    for (const champ of ['nom', 'prenom', 'telephone', 'fonction', 'role', 'statut', 'permissions']) {
      if (data[champ] !== undefined) updates[champ] = data[champ];
    }

    await utilisateur.update(updates);
    return { success: true, message: 'Membre mis à jour avec succès', utilisateur };
  }

  static async supprimerMembre(organisationId, membreId) {
    const utilisateur = await Utilisateur.findOne({
      where: { id: membreId, organisationId },
    });
    if (!utilisateur) return { success: false, message: 'Membre introuvable dans cette organisation' };
    if (utilisateur.role === 'Admin') {
      return { success: false, message: 'Impossible de supprimer un compte Admin' };
    }

    // RGPD art. 17 — ce chemin ne faisait qu'un `destroy()` paranoid : nom,
    // prénom, email, téléphone, photo et fonction du membre restaient en base
    // en clair, indéfiniment. Effet de bord supplémentaire : email et telephone
    // portant un index unique COMPLET, la ligne soft-deleted continuait
    // d'occuper l'adresse et le membre ne pouvait plus JAMAIS être réinscrit
    // (le contrôle applicatif ne voyait rien, PostgreSQL rejetait en 23505 →
    // 409 « Cette ressource existe déjà »).
    // Implémentation unique, partagée avec l'auto-suppression et la suppression
    // par le super-admin : pseudonymisation du profil + anonymisation des
    // journaux de connexion + révocation des sessions, puis suppression logique.
    // Require local et non en tête de fichier : ce module est partagé et son
    // en-tête est édité en parallèle (peut être hissé en haut sans risque).
    const AccountService = require('../../account/service/account.service.js');
    await AccountService.pseudonymiserEtSupprimer(utilisateur);

    return { success: true, message: 'Membre retiré de l’organisation' };
  }

  // -------------------- ÉQUIPES --------------------
  static async creerEquipe(organisationId, data) {
    const equipe = await Equipe.create({
      organisationId,
      nom: data.nom,
      description: data.description || null,
    });

    if (data.membreIds && data.membreIds.length) {
      const membres = await Utilisateur.findAll({ where: { id: data.membreIds, organisationId } });
      await equipe.setMembres(membres.map((m) => m.id));
    }

    return { success: true, message: 'Équipe créée avec succès', equipe };
  }

  /** L'email des coéquipiers n'est exposé qu'aux rôles de gestion (cf. getOrganisation). */
  static async listEquipes(organisationId, role = null) {
    const peutVoirEmails = role === 'Admin' || GESTION.includes(role);
    const attributs = peutVoirEmails
      ? ['id', 'nom', 'prenom', 'email', 'role', 'photoProfil']
      : ['id', 'nom', 'prenom', 'role', 'photoProfil'];

    const equipes = await Equipe.findAll({
      where: { organisationId },
      include: [{ model: Utilisateur, as: 'membres', attributes: attributs }],
      order: [['createdAt', 'DESC']],
    });
    return { success: true, equipes };
  }

  static async ajouterMembreEquipe(organisationId, equipeId, membreIds) {
    const equipe = await Equipe.findOne({ where: { id: equipeId, organisationId } });
    if (!equipe) return { success: false, message: 'Équipe introuvable' };

    const membres = await Utilisateur.findAll({ where: { id: membreIds, organisationId } });
    if (membres.length !== membreIds.length) {
      return { success: false, message: 'Certains membres ne font pas partie de cette organisation' };
    }

    await equipe.addMembres(membres.map((m) => m.id));
    return { success: true, message: 'Membres ajoutés à l’équipe' };
  }

  static async retirerMembreEquipe(organisationId, equipeId, membreId) {
    const equipe = await Equipe.findOne({ where: { id: equipeId, organisationId } });
    if (!equipe) return { success: false, message: 'Équipe introuvable' };

    await equipe.removeMembres(membreId);
    return { success: true, message: 'Membre retiré de l’équipe' };
  }

  static async supprimerEquipe(organisationId, equipeId) {
    const equipe = await Equipe.findOne({ where: { id: equipeId, organisationId } });
    if (!equipe) return { success: false, message: 'Équipe introuvable' };

    await equipe.destroy(); // soft delete
    return { success: true, message: 'Équipe supprimée' };
  }

  // -------------------- FILIALES & AGENCES (module 2) --------------------
  /** Crée une filiale rattachée à l'organisation courante. */
  static async creerFiliale(organisationId, data) {
    const parent = await Organisation.findByPk(organisationId);
    if (!parent) return { success: false, message: 'Organisation introuvable' };
    if (parent.type === 'agence') {
      return { success: false, message: 'Une agence ne peut pas avoir de filiale' };
    }

    if (data.siret) {
      const exist = await Organisation.findOne({ where: { siret: data.siret } });
      if (exist) return { success: false, message: 'Ce SIRET est déjà enregistré' };
    }

    const filiale = await Organisation.create({
      nom: data.nom,
      raison_sociale: data.raison_sociale || data.nom,
      siret: data.siret || null,
      num_tva: data.num_tva || null,
      rccm: data.rccm || null,
      ninea: data.ninea || null,
      telephone: data.telephone || null,
      email: data.email ? data.email.toLowerCase() : null,
      adresse: data.adresse || null,
      ville: data.ville || null,
      pays: data.pays || 'France',
      type: 'filiale',
      parent_id: organisationId,
      // L'essai suit celui de la maison mère. Sans cela, le modèle applique un
      // nouvel essai de 7 jours à chaque filiale : il suffisait d'en créer une
      // tous les 7 jours pour prolonger l'essai indéfiniment.
      trial_ends_at: parent.trial_ends_at,
      is_subscribed: parent.is_subscribed,
    });

    return { success: true, message: 'Filiale créée avec succès', filiale };
  }

  /** Crée une agence rattachée à une filiale de l'organisation. */
  static async creerAgence(organisationId, filialeId, data) {
    const filiale = await Organisation.findOne({
      where: { id: filialeId, type: 'filiale', parent_id: organisationId },
    });
    if (!filiale) return { success: false, message: 'Filiale introuvable dans votre organisation' };

    const agence = await Organisation.create({
      nom: data.nom,
      raison_sociale: data.raison_sociale || data.nom,
      telephone: data.telephone || null,
      email: data.email ? data.email.toLowerCase() : null,
      adresse: data.adresse || null,
      ville: data.ville || null,
      pays: data.pays || 'France',
      type: 'agence',
      parent_id: filialeId,
      // Même règle que pour les filiales : l'agence hérite de l'essai et de
      // l'abonnement de sa filiale de rattachement.
      trial_ends_at: filiale.trial_ends_at,
      is_subscribed: filiale.is_subscribed,
    });

    return { success: true, message: 'Agence créée avec succès', agence };
  }

  /** Liste les filiales (et leurs agences) de l'organisation. */
  static async listFiliales(organisationId) {
    const filiales = await Organisation.findAll({
      where: { parent_id: organisationId },
      order: [['nom', 'ASC']],
    });

    // Charger les agences de chaque filiale (batch)
    const filialeIds = filiales.map((f) => f.id);
    const agences = filialeIds.length
      ? await Organisation.findAll({ where: { parent_id: filialeIds }, order: [['nom', 'ASC']] })
      : [];

    return {
      success: true,
      filiales: filiales.map((f) => ({
        ...f.toJSON(),
        agences: agences.filter((a) => String(a.parent_id) === String(f.id)),
      })),
    };
  }

  /** Organigramme : organisation → filiales → agences (module 2). */
  static async organigramme(organisationId) {
    const organisation = await Organisation.findByPk(organisationId);
    if (!organisation) return { success: false, message: 'Organisation introuvable' };

    const filiales = await Organisation.findAll({
      where: { parent_id: organisationId },
      order: [['nom', 'ASC']],
    });
    const filialeIds = filiales.map((f) => f.id);
    const agences = filialeIds.length
      ? await Organisation.findAll({ where: { parent_id: filialeIds }, order: [['nom', 'ASC']] })
      : [];

    return {
      success: true,
      organigramme: {
        entreprise: organisation,
        filiales: filiales.map((f) => ({
          ...f.toJSON(),
          agences: agences.filter((a) => String(a.parent_id) === String(f.id)),
        })),
      },
    };
  }

  // -------------------- IMPORT DE CONTACTS (module 2) --------------------
  /**
   * Importe des contacts (membres) depuis un CSV.
   * Colonnes attendues : prenom, nom, email, telephone, fonction, role.
   * Les emails déjà existants sont ignorés (best-effort par ligne).
   */
  static async importContacts(organisationId, buffer, roleDefaut = 'Client') {
    let records;
    try {
      const { parse } = require('csv-parse/sync');
      records = parse(buffer.toString('utf8'), {
        columns: true,
        skip_empty_lines: true,
        trim: true,
        relax_column_count: true,
      });
    } catch (err) {
      return { success: false, message: 'Fichier CSV illisible : ' + err.message };
    }

    if (!records.length) return { success: false, message: 'Le fichier CSV est vide' };

    // Plafond DUR sur le nombre de lignes. La taille du fichier ne le borne pas
    // fiablement (un CSV étroit est dense), or chaque ligne déclenche un SELECT
    // puis un bcrypt.hash à 12 rounds en JS pur — soit ~300 ms de CPU BLOQUANT
    // l'unique boucle d'événements de Node. Sans ce plafond, un fichier de
    // quelques centaines de Ko immobilisait l'API pendant des heures.
    const MAX_LIGNES_IMPORT = 500;
    if (records.length > MAX_LIGNES_IMPORT) {
      return {
        success: false,
        message: `Fichier trop volumineux : ${records.length} lignes (maximum ${MAX_LIGNES_IMPORT} par import). Découpez le fichier.`,
      };
    }

    const results = [];
    for (const row of records) {
      const email = (row.email || '').trim().toLowerCase();
      const nom = (row.nom || '').trim();
      const prenom = (row.prenom || '').trim();

      if (!email) {
        results.push({ nom, prenom, email: null, statut: 'erreur', erreur: 'email manquant' });
        continue;
      }
      const exist = await Utilisateur.findOne({ where: { email } });
      if (exist) {
        results.push({ nom, prenom, email, statut: 'existant' });
        continue;
      }

      const role = ROLES_IMPORT.includes(row.role) ? row.role : roleDefaut;
      const motDePasseTemporaire = crypto.randomBytes(6).toString('hex');

      await Utilisateur.create({
        organisationId,
        nom: nom || email.split('@')[0],
        prenom: prenom || '',
        email,
        mot_de_passe: await bcrypt.hash(motDePasseTemporaire, bcryptConfig.saltRounds),
        telephone: row.telephone || null,
        fonction: row.fonction || null,
        role,
        statut: 'actif',
        mdp_temporaire: true, // mot de passe temporaire → rotation au 1er login
        email_verifie: true,  // importé par un acteur de confiance de l'organisation
      });

      results.push({ nom, prenom, email, role, statut: 'importe', motDePasseTemporaire });
    }

    const importes = results.filter((r) => r.statut === 'importe').length;
    return {
      success: true,
      message: `Import terminé : ${importes} contact(s) importé(s), ${results.length - importes} ignoré(s)`,
      results,
    };
  }
}

module.exports = OrganisationService;
