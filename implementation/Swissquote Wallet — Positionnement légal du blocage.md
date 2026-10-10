# Swissquote Wallet — Positionnement légal du blocage

> Note de travail de l'équipe, **pas un avis juridique**. Les références légales sont à faire
> valider par un juriste avant le pitch. Destinataires : P1 (policy), P2 (UI), P3 (SDK et one-pager légal).

## Décision (2026-10-10)

**Swissquote ne bloque jamais une transaction parce qu'elle paraît risquée.** Il avertit et demande une
double confirmation ; le client décide.

| Situation | Ce qui se passe |
| --- | --- |
| Aucun signal ou risque faible | Signature passkey, co-signature, envoi |
| Risque modéré (ex. gros montant) | Seconde confirmation passkey, puis envoi |
| Risque élevé ou critique **sans** motif réglementaire | Alerte « Risque élevé détecté » avec les raisons, case « Je comprends les risques » que le client coche lui-même, seconde confirmation passkey, puis envoi. **Ni délai, ni blocage.** |
| Motif réglementaire (sanctions) | Seule exception : refus de co-signer, sans détailler le motif (« raisons réglementaires »). C'est une obligation légale de Swissquote, pas une promesse de protection. |

Conséquence : il n'y a **plus de « hold »**, ni revue par Swissquote, ni justification, ni délai
d'expiration. L'écran Hold de la Frontend Spec est remplacé par l'alerte de risque élevé dans Confirm.

## Pourquoi

Le dossier présentait Swissquote comme celui qui **bloque les mauvaises transactions** (README :
« every transaction is risk-scored, co-signed by Swissquote » ; Rust Spec : « High hold · Critical refuse »).
Ce discours crée trois risques.

1. **Faux négatif.** Si on promet de bloquer la fraude et qu'une transaction frauduleuse passe, le client
   peut soutenir que Swissquote n'a pas tenu son engagement. Promettre un résultat (« on bloque ») au lieu
   d'un effort (« on analyse et on alerte ») aggrave fortement cette exposition.
2. **Faux positif.** Bloquer une transaction légitime (un loyer, un paiement urgent) expose à réclamer le
   dommage causé par le retard ou le refus.
3. **Réglementaire.** Plus Swissquote décide de ce qui passe, plus il ressemble à un intermédiaire qui
   contrôle les fonds. Or la thèse du produit est « Swissquote ne peut jamais déplacer les fonds, ce n'est
   pas de la garde ». Un pouvoir de blocage large affaiblit cette thèse.

Le principe retenu : **Swissquote fournit une analyse de risque et une seconde signature ; il ne garantit
pas que les transactions dangereuses seront arrêtées.** C'est une obligation de moyens, pas de résultat.
Le client reste maître de ses fonds et de ses décisions, et l'acceptation explicite du risque est tracée.

Argument pour le pitch : l'architecture va dans le même sens. Avec l'**escape hatch**, le client peut de
toute façon sortir ses fonds sans Swissquote après un timelock. Swissquote est structurellement incapable
de garantir un blocage, et le produit l'assume.

### Options écartées

- **Délai de sécurité** : le hold devient un délai de réflexion, que le client peut lever à l'expiration.
  Plus de complexité (expiration, justification, données personnelles) pour un gain juridique faible face
  à l'avertissement avec double confirmation.
- **Statu quo (on bloque)** : compenser par des CGU qui excluent la responsabilité ne couvre pas tout ; en
  droit suisse, l'exclusion est nulle pour la faute grave (CO art. 100, à confirmer). Fait aussi de
  Swissquote un gardien des transactions.

## Deux catégories à ne plus mélanger

Le code mélangeait tout dans un seul score. Désormais :

| Catégorie | Codes actuels | Nature | Ce que fait Swissquote |
| --- | --- | --- | --- |
| **Refus réglementaire** | `SANCTIONED` | Obligation légale de Swissquote | Refuse de co-signer, sans détailler le motif |
| **Analyse de risque** | `MIXER_EXPOSURE`, `SIMULATED_DRAIN`, `LARGE_AMOUNT`, `NEW_RECIPIENT`, `UNLIMITED_APPROVAL`, `PERMIT_SIGNATURE`, `UNKNOWN_*` | Aide à la décision du client | Avertit et demande une double confirmation, **ne bloque jamais** |

Point de vigilance : un score élevé **sans** sanction (ex. `SIMULATED_DRAIN` 50 + `UNLIMITED_APPROVAL` 30
+ `NEW_RECIPIENT` 20 = 100) donnait jusqu'ici un refus définitif. Avec la décision, il donne une alerte.

## Ce qu'il faut réviser

### 1. Backend et policy (P1) — à faire

| Où | Aujourd'hui | À faire |
| --- | --- | --- |
| Rust Spec l. 139 (co-sign algorithm) | `Low co-sign · Medium step-up · High hold · Critical refuse`, décidé par le score | Refus **uniquement** si une raison réglementaire est présente. Sinon : `Low` co-signe, tout le reste renvoie `step_up` ; co-signature dès que la seconde confirmation est faite. |
| Réponse `step_up` de `/cosign` | Pas de niveau | Ajouter `level: standard | high_risk` (`high_risk` à partir de `High`) pour que l'UI affiche l'alerte |
| `LogEntry` / reçu | `step_up: bool` | Tracer que le client a **accepté le risque** (preuve en cas de litige) |
| `fixtures/policy.json` | Seulement `thresholds` | Ajouter par exemple `"regulatory_refusal_codes": ["SANCTIONED"]` |
| `holds.rs`, `/holds/*`, `HoldState` | Hold avec revue « mock compliance » (au moins 10 caractères, pas de « fraud » ni « urgent ») | **Supprimer** |
| README l. 81–82 et l. 96 | `High → hold`, `Critical → refused`, endpoints holds | Table de démo : « Mixer → alerte + double confirmation », « Sanctions → refus réglementaire » ; retirer les holds |

### 2. Interface (P2) — ✅ fait dans `frontend/packages/extension`

| Élément | Changement |
| --- | --- |
| Confirm | Nouveau widget `sq-risk-warning` : alerte, raisons, case « Je comprends les risques et je souhaite envoyer cette transaction », phrase « Swissquote ne bloque pas cette transaction ». Le bouton de seconde confirmation reste désactivé tant que la case n'est pas cochée. |
| Onboarding | Case de consentement obligatoire (« J'accepte les conditions d'utilisation et je comprends que l'analyse de risque de Swissquote est indicative ») avant la création de la passkey |
| Onboarding et Confirm | `sq-legal-notice` : « L'analyse de risque de Swissquote est indicative : elle ne garantit pas la détection des transactions frauduleuses et ne les bloque pas. Vous restez seul décisionnaire de vos transactions. » |
| Refus | « Cette transaction ne peut pas être co-signée pour des raisons réglementaires. Vos fonds n'ont pas bougé. » Sans liste de raisons. |
| Libellé `SANCTIONED` | « Motif réglementaire » au lieu de « Destinataire sous sanctions » (interdiction d'informer, LBA art. 10a, à confirmer) |
| Badge de risque | « Aucun signal détecté » quand le score est 0, au lieu de « Risque faible » qui se lit comme « sûr » |
| Issue « en attente » | Supprimée |

Le contrat `UiBridge` a changé : `confirmation_required` avec `level`, `refused` avec
`reason: 'regulatory'`, plus de `justifyHold`. **À valider avec P3.**

### 3. SDK et extension (P3) — à faire

| Où | À faire |
| --- | --- |
| Middleware Spec l. 76 | Retirer `justify` du port `SwissquoteApi` |
| Middleware Spec l. 110 | Flux SendTransaction : co-signé / seconde confirmation (`standard` ou `high_risk`) / refus réglementaire |
| Background | **Notification système** (`chrome.notifications`) « Risque élevé détecté » quand la transaction vient d'un dApp et que la fenêtre d'approbation n'est pas au premier plan |
| Adapter `HttpSwissquoteApi` | Mapper la réponse `step_up` + `level` vers `confirmation_required` |

### 4. One-pager légal (P3) : points à ajouter

En plus des trois points déjà prévus (garde, FINMA et self-hosted wallets, AML et revLPD) :

1. **Nature de l'engagement** : analyse de risque = obligation de moyens ; ce qui est promis et ce qui ne l'est pas.
2. **Un seul refus** : réglementaire, obligatoire, non motivé auprès du client. Le risque ne fait qu'avertir.
3. **Acceptation explicite** : le client coche et confirme deux fois ; c'est tracé dans le journal d'audit.
4. **Pourquoi l'escape hatch renforce la position** : Swissquote ne peut ni déplacer ni immobiliser durablement les fonds.
5. **Responsabilité** : ce que les conditions d'utilisation peuvent exclure, et ce qu'elles ne peuvent pas exclure (faute grave).
6. **Interdiction d'informer** : comment l'UI reste neutre sur les refus réglementaires.

## Vocabulaire

| À éviter | À utiliser |
| --- | --- |
| « Swissquote bloque les fraudes », « vous protège » | « Swissquote analyse chaque transaction et vous alerte » |
| « transaction sûre », « validée », « sécurisée » | « aucun signal de risque détecté » |
| « bank-grade », « garanti » | « co-signé par Swissquote », « journal d'audit signé » |
| « bloquée », « en attente de validation » | « risque élevé détecté : confirmez si vous êtes sûr » |
| « refusée car destinataire sanctionné » | « refusée pour des raisons réglementaires » |

## Questions ouvertes pour un juriste

1. Un 2-of-2 où Swissquote peut refuser mais jamais déplacer : est-ce un « pouvoir de disposition » au sens LBA/FINMA ?
2. Avertissement + acceptation explicite + double confirmation : est-ce suffisant pour qu'on ne puisse pas reprocher à Swissquote d'avoir laissé passer une fraude ? Sous quelle forme conserver la preuve de l'acceptation ?
3. Sanctions : le refus de co-signer est-il obligatoire et suffisant, ou faut-il aussi annoncer et geler ? Que peut-on dire au client ?
4. Les reçus signés et le journal d'audit peuvent-ils servir de piste pour la travel rule (FINMA, communication 02/2019) ?
5. Clause type des conditions d'utilisation sur les limites de l'analyse de risque.
