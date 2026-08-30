# Abonnements, paiement et restrictions

Documentation de référence du module `subscription`. Elle décrit ce qui est
**réellement implémenté** ; les points restés ouverts sont signalés par
« ⚠️ À trancher avec le client » et ne doivent pas être présentés comme acquis.

---

## 1. Principe directeur

Trois règles gouvernent tout le module :

1. **Le serveur est seul juge.** Aucun prix, aucune limite, aucun droit n'est
   décidé par le Web ou le Mobile. Les deux clients affichent ce que l'API leur
   envoie.
2. **Un paiement n'existe que confirmé par le fournisseur.** L'affirmation du
   frontend (« le paiement a réussi ») ne déclenche jamais l'activation d'un
   abonnement. Seul le webhook signé le fait.
3. **L'historique ne se réécrit pas.** Le prix payé est figé à la souscription.
   Modifier un tarif au catalogue n'affecte aucune souscription passée.

---

## 2. Catalogue des formules

Les formules vivent en base (`plans_abonnement`), plus dans le code.

| Code | Nom | Prix | Limite utilisateurs | Fonctionnalités |
|---|---|---|---|---|
| `essentiel` | Essentiel | 49 € / mois | 2 | `reserves`, `mobile`, `stockage`, `support_prioritaire` |
| `pro` | Pro | 89 € / mois | 5 | socle + `suivi_equipe`, `rapports`, `annotations`, `api` |
| `entreprise` | Entreprise | **sur devis** (`prix = NULL`) | illimité (`NULL`) | socle + avancées |

Valeurs issues **exclusivement** de la présentation commerciale fournie. Elles
sont posées par la migration `20260829000009-abonnements-catalogue.js` puis
modifiables par l'administrateur ; le tableau ci-dessus décrit l'état initial.

### Conventions de valeurs

Trois conventions, à respecter partout — elles sont la source d'erreur la plus
fréquente sur ce module :

- `prix = NULL` → **sur devis**. Ce n'est pas « gratuit ». La formule s'affiche
  mais ne se paie pas en ligne ; l'API répond `SUBSCRIPTION_QUOTE_REQUIRED`.
- `limite_utilisateurs = NULL` / `limite_chantiers = NULL` → **illimité**.
  La sentinelle `-1` de l'ancien code n'existe plus.
- `fonctionnalites = []` → **aucune**, tandis que `fonctionnalites = null` dans
  la réponse `/droits` → **toutes** (période d'essai). Confondre les deux
  ouvrirait tout aux organisations sans droits ; c'est testé.

Le champ **`code` est la clé stable**. L'administrateur peut renommer une
formule ; `id` est un UUID technique et `nom` un libellé commercial. Tout
rapprochement (frontend compris) se fait sur `code`.

---

## 3. Structure de la base

### `plans_abonnement` — le catalogue

`id`, `code` (unique), `nom`, `description`, `prix` (nullable), `devise`,
`periode` (`mois` | `an`), `limite_utilisateurs` (nullable),
`limite_chantiers` (nullable), `fonctionnalites` (JSON de codes), `ordre`,
`actif`.

Désactiver (`actif = false`) retire la formule de la vente **sans toucher aux
abonnés en cours**, qui la gardent jusqu'à leur échéance. C'est le geste normal
de retrait d'une offre. La suppression est refusée dès qu'une souscription y
renvoie.

### `abonnements_souscrits` — l'historique

`organisationId`, `planAbonnementId` (**`ON DELETE SET NULL`**), et surtout les
**instantanés figés** : `plan_code`, `plan_nom`, `prix_paye`, `devise`,
`periode`. Plus `statut` (`en_attente` | `actif` | `annule` | `expire`),
`date_debut`, `date_fin`, `reference_paiement`, `fournisseur`, `activee_par`.

Les instantanés sont ce qui permet de supprimer une formule du catalogue sans
perdre la trace de ce qu'un client a payé. C'est aussi ce qui rend la table
utilisable comme pièce comptable.

### `evenements_paiement` — l'idempotence

`fournisseur`, `evenement_id`, `type`, `recu_le`, `traite_le`, `erreur`.
Index unique sur `(fournisseur, evenement_id)`.

L'événement est enregistré **avant** traitement : `traite_le IS NULL` distingue
alors « jamais vu » de « vu mais échoué », ce qu'un simple booléen ne dirait
pas. Un webhook rejoué ne produit donc jamais deux activations.

---

## 4. Endpoints

### Public / client

| Méthode | Route | Auth | Rôle | Objet |
|---|---|---|---|---|
| GET | `/api/v1/abonnement/plans` | non | — | Catalogue des formules actives |
| GET | `/api/v1/abonnement/status` | oui | tous | Statut (abonné, essai, échéance) |
| GET | `/api/v1/abonnement/droits` | oui | tous | Droits effectifs **+ consommation** |
| GET | `/api/v1/abonnement/plan-details` | oui | tous | Détail de la formule en cours |
| GET | `/api/v1/abonnement/historique` | oui | GESTION | Souscriptions passées |
| POST | `/api/v1/abonnement/payment-intent` | oui | GESTION | Ouvre un paiement Stripe |
| POST | `/api/v1/abonnement/change-plan` | oui | GESTION | Changement de formule |
| POST | `/api/v1/abonnement/cancel` | oui | GESTION | Résiliation |
| POST | `/api/v1/abonnement/webhook` | **signature** | — | Événements Stripe |

`/plans` est **volontairement public et exempté de `checkSubscription`** : une
organisation dont l'essai est terminé doit encore pouvoir consulter les offres —
c'est précisément le moment où elle en a besoin.

`/cancel` exige un rôle GESTION. Sans cela, n'importe quel membre — un rôle
Client externe compris — pouvait résilier et bloquer toute l'organisation.

### Administration plateforme (`requireRole('Admin')`)

| Méthode | Route | Objet |
|---|---|---|
| GET | `/api/v1/admin/plans-abonnement` | Liste du catalogue |
| GET | `/api/v1/admin/plans-abonnement/:id` | Détail |
| POST | `/api/v1/admin/plans-abonnement` | Création d'une formule |
| PUT | `/api/v1/admin/plans-abonnement/:id` | Modification (prix compris) |
| PATCH | `/api/v1/admin/plans-abonnement/:id/actif` | Mise en vente / retrait |
| DELETE | `/api/v1/admin/plans-abonnement/:id` | Suppression (refusée si utilisée) |
| GET | `/api/v1/admin/abonnements` | Suivi des souscriptions clients |
| POST | `/api/v1/admin/abonnements/activer` | **Activation manuelle** (cas « sur devis ») |

Ces routes sont montées **hors** de `checkSubscription` : l'administrateur
plateforme n'appartient à aucune organisation, l'y soumettre lui fermerait
l'administration qu'il exerce.

L'activation manuelle est la seule écriture sur l'historique. Elle contourne
délibérément le paiement en ligne, d'où trois garde-fous : rôle super-admin,
trace de l'auteur (`activee_par`), prix explicite obligatoire.

---

## 5. Parcours de paiement Stripe

```
Client (Web)                    API                        Stripe
     │                           │                            │
     │  POST /payment-intent     │                            │
     │  { planId }               │                            │
     ├──────────────────────────>│                            │
     │                           │ lit le PRIX EN BASE        │
     │                           │ (jamais celui du client)   │
     │                           ├── PaymentIntent.create ───>│
     │                           │<────── clientSecret ───────┤
     │                           │ crée AbonnementSouscrit    │
     │                           │ statut = « en_attente »    │
     │<──── clientSecret ────────┤                            │
     │                           │                            │
     │  confirmCardPayment (clé PUBLIABLE, dans le navigateur) │
     ├────────────────────────────────────────────────────────>│
     │                           │                            │
     │                           │<── webhook signé ──────────┤
     │                           │   payment_intent.succeeded │
     │                           │                            │
     │                           │ vérifie la signature       │
     │                           │ enregistre l'événement     │
     │                           │ passe le statut à « actif »│
```

**Le point à retenir :** l'activation a lieu à la dernière étape, déclenchée par
Stripe, jamais par le navigateur. Un client qui appellerait lui-même une route
en prétendant avoir payé n'obtiendrait rien.

Le montant facturé est **relu en base** au moment de créer le PaymentIntent : un
`prix` envoyé par le client est ignoré.

### Vérification de signature

Elle porte sur les **octets bruts** du corps de la requête. Re-sérialiser
`req.body` produit un JSON différent (espaces, ordre des clés) et la signature
échoue systématiquement. `rawBodyMiddleware` doit rester le tout premier
middleware de la route `/webhook`, et le hook `verify` posé sur `express.json`
capture les octets en amont. **Ne jamais insérer de parseur avant cette ligne.**

### PayTech

Le second fournisseur passe par le même point d'entrée
(`traiterEvenement('paytech', token, 'sale_complete', …)`), donc par la même
idempotence et la même règle d'activation.

---

## 6. Restrictions appliquées

Les gardes vivent dans `middlewares/requireFonctionnalite.middleware.js` et
sont posées route par route.

| Fonctionnalité | Ce qui est effectivement gardé |
|---|---|
| `suivi_equipe` | `/organisation/equipes` |
| `rapports` | `POST /chantiers/:chantierId/rapports/generer` uniquement |
| `annotations` | Annotations et zones cliquables des plans |
| `api` | Rien pour l'instant — aucune API publique n'existe |
| `reserves`, `mobile`, `stockage`, `support_prioritaire` | Socle commun, présent dans toutes les formules |

### Limites de volume

| Ressource | Garde |
|---|---|
| `chantiers` | Création d'un chantier |
| `utilisateurs` | Ajout et invitation d'un membre |

`verifierLimite(ressource)` compte l'existant et refuse **avant** l'écriture.

### Décisions d'interprétation — ⚠️ à confirmer

Deux points du visuel commercial ne se traduisent pas mécaniquement en gardes ;
les choix faits sont conservateurs et documentés dans le code :

- **`annotations`** garde l'annotation des plans, **pas leur consultation ni
  leur dépôt**. Fermer les plans à Essentiel viderait « Gestion des réserves »,
  qui figure pourtant dans son socle : créer une réserve en cliquant sur un plan
  est le cœur du produit.
- **`rapports`** garde la génération, **pas la lecture ni la liste**. Un rapport
  déjà produit a été payé sous la formule d'alors ; le fermer rétroactivement
  reviendrait à reprendre une livraison. Le tableau de bord n'est pas gardé non
  plus — c'est l'écran d'accueil.

### Codes d'erreur

| Code HTTP | `code` | Sens |
|---|---|---|
| 403 | `SUBSCRIPTION_REQUIRED` | Aucun abonnement ni essai actif |
| 403 | `SUBSCRIPTION_FEATURE_UNAVAILABLE` | Formule active, fonctionnalité non incluse |
| 403 | `SUBSCRIPTION_LIMIT_REACHED` | Plafond de volume atteint |
| 400 | `SUBSCRIPTION_QUOTE_REQUIRED` | Formule « sur devis », pas de paiement en ligne |

Le super-admin plateforme (`role === 'Admin'`) traverse toutes ces gardes.

---

## 7. Clients

### Web (`admin/`)

- **`/abonnement`** — offres, formule en cours, paiement par carte.
- **Admin → « Prix abonnements »** (`/plateforme/prix-abonnements`) — catalogue :
  prix, limites, fonctionnalités, mise en vente ou retrait. Un bandeau y
  rappelle que modifier un prix n'affecte aucune souscription passée.

Aucun prix n'est écrit dans le code ; les libellés de fonctionnalités sont
traduits à partir des **codes** reçus, pour suivre la langue de l'utilisateur.

### Mobile (`mobile/`)

- Écran **Abonnement** (`/abonnement`, accessible depuis Profil → « Voir les
  formules ») : offres, formule en cours, consommation face aux limites.
- `DroitsAbonnement.peut(code)` sert **uniquement à masquer ou griser**. Les
  gardes réelles vivent dans l'API : un binaire mobile modifié n'obtient aucun
  accès supplémentaire.

⚠️ **Le paiement mobile ouvre la page web** (`url_launcher`), il n'est pas natif.
Intégrer `flutter_stripe` demanderait un module à code natif ; le
`pubspec.yaml` documente qu'un précédent ajout de ce type (`rive_native`) a fait
échouer le build Android sur la machine de développement, et rien ne permettait
de vérifier l'intégration ici. **À rouvrir si le client veut un paiement 100 %
natif.**

---

## 8. Variables d'environnement

### Backend (`.env`)

```
STRIPE_SECRET_KEY=sk_live_…        # JAMAIS côté frontend
STRIPE_PUBLISHABLE_KEY=pk_live_…
STRIPE_WEBHOOK_SECRET=whsec_…      # signature du webhook

PAYTECH_API_KEY=…
PAYTECH_API_SECRET=…
PAYTECH_ENV=prod
PAYTECH_BASE_URL=https://paytech.sn/api
```

### Web (`admin/.env`)

```
VITE_STRIPE_PUBLISHABLE_KEY=pk_live_…
```

**Seule la clé publiable est exposée au navigateur.** Une clé `sk_` dans le
frontend permettrait de créer des remboursements et de lire les données de tous
les clients : elle doit être révoquée immédiatement si elle a fuité.

`STRIPE_PRICE_*` subsiste dans `.env.example` mais n'est plus utilisé — le prix
vient de la base.

---

## 9. Procédure de test

### Automatisée

```bash
cd backend && npm test
```

Couvre notamment : idempotence du webhook (rejeu sans double activation),
distinction `null` / `[]` sur les fonctionnalités, refus de suppression d'une
formule utilisée, gel du prix payé, `SUBSCRIPTION_QUOTE_REQUIRED` sur une
formule sur devis.

```bash
cd admin  && npm test
cd mobile && flutter test --concurrency=1
```

### Manuelle, avec Stripe en mode test

1. `stripe listen --forward-to localhost:3000/api/v1/abonnement/webhook`
   (reporter le `whsec_…` affiché dans `STRIPE_WEBHOOK_SECRET`).
2. Web → `/abonnement`, choisir **Pro**, payer avec `4242 4242 4242 4242`
   (date future, CVC quelconque).
3. Vérifier en base : `abonnements_souscrits` passe de `en_attente` à `actif`,
   `prix_paye = 89.00`, `reference_paiement` renseignée.
4. **Rejouer** le même événement (`stripe events resend <id>`) : aucun second
   abonnement ne doit apparaître, et `evenements_paiement` ne gagne aucune ligne.
5. Carte refusée `4000 0000 0000 0002` : la souscription reste `en_attente`,
   aucun accès n'est ouvert.
6. Depuis un compte **Essentiel**, tenter `POST /chantiers/:id/rapports/generer`
   → 403 `SUBSCRIPTION_FEATURE_UNAVAILABLE`.
7. Toujours en Essentiel, inviter un 3ᵉ utilisateur → 403
   `SUBSCRIPTION_LIMIT_REACHED`.
8. Admin → « Prix abonnements » : passer Pro à 99 €. Vérifier que la
   souscription de l'étape 3 affiche **toujours 89 €**.
9. Formule **Entreprise** : le bouton propose « Nous contacter » ; l'appel
   direct à `/payment-intent` répond `SUBSCRIPTION_QUOTE_REQUIRED`.
   Activer alors manuellement via `POST /admin/abonnements/activer`.

---

## 10. Mise en production

- [ ] Migrations appliquées (`npx sequelize-cli db:migrate`), catalogue vérifié
      en base.
- [ ] `STRIPE_SECRET_KEY` et `STRIPE_WEBHOOK_SECRET` en valeurs **live**.
- [ ] Endpoint webhook déclaré dans le tableau de bord Stripe, en HTTPS, avec
      les événements `payment_intent.succeeded` et `payment_intent.payment_failed`.
- [ ] `VITE_STRIPE_PUBLISHABLE_KEY` en `pk_live_…` côté web.
- [ ] **Vérifier qu'aucune clé `sk_` n'est présente dans un bundle frontend**
      (`grep -r "sk_live" admin/dist`).
- [ ] Prix du catalogue relus et validés par le client avant ouverture.
- [ ] Un premier paiement réel de bout en bout, puis remboursement depuis
      Stripe.
- [ ] Journalisation des webhooks en échec surveillée (`evenements_paiement`
      avec `traite_le IS NULL` et `erreur` renseignée).
