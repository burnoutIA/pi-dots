# dots

Un dot est un agent [pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) autonome et proactif. Il vit dans un environnement clos (un conteneur docker ou podman), livré déjà préconfiguré, avec son propre OS et ses outils. On peut lui demander à peu près tout : il se débrouille. La seule règle imposée est la sécurité : tout ce qui sort, et tous les secrets, passent par son **coffre**.

Il tourne quand on l'allume. Quand on l'éteint, il reprend là où il en était au démarrage suivant. Le périmètre du projet est dans [PERIMETRE.md](PERIMETRE.md).

## Un dot, c'est un dossier

Un dot vit dans un dossier, où que ce soit sur le disque :

```text
travail/
  travail.dot     son fichier : en-tête, réglages (env), providers (model), secrets (vault)
  skills/         ses savoir-faire
  extensions/     ses extensions pi
  state/          sa vie : mémoire, plan, sessions, journal, fichiers, livrables
```

- **Copier tout le dossier**, c'est obtenir le même dot.
- **Le copier sans `state/`**, c'est obtenir un dot vierge : mêmes accès et savoir-faire, sans son passé (`./dot copie travail perso --vierge`, qui retire aussi Telegram puisqu'un bot n'a qu'un lecteur).
- Les conteneurs ne sont qu'une **instance jetable** : ils sont recréés à chaque démarrage à partir de l'image, et montent le dossier. Rien de ce qui compte ne vit dedans. Deux copies d'un même dot, posées à deux endroits, ont chacune leurs conteneurs.

### Le fichier `.dot`

```yaml
---
name: travail
description: Mon assistant de travail. Brief du matin, suivi de mes projets.
onclic: chat          # double-clic : le dot est lancé, puis chat (la conversation) ou none
---
# Réglages : le dot les reçoit comme variables d'environnement. Aucun secret ici.
env:
  DOT_PROVIDER: local
  DOT_MODEL: mon-modele
  DOT_INTERFACE: rpc
  TELEGRAM_OWNER_ID: "123456"
  TZ: Europe/Paris

# Les providers de pi : baseUrl passe par le coffre, apiKey est un {{NOM}} du vault.
model:
  providers:
    local: { baseUrl: "http://dot-vault:8080/http/host.docker.internal:8080/v1", api: openai-completions, apiKey: "{{MODEL_KEY}}", models: [ … ] }

# Les secrets : lus et mis à jour par le coffre seul.
vault:
  secrets:
    MODEL_KEY: { value: "sk-…", hosts: [host.docker.internal:8080] }
  allow: []
```

- **Le dot ne voit jamais ce fichier.** Au démarrage, l'application en extrait seulement `env` et `model` pour lui. Seul le coffre lit le nœud `vault`, et il y ajoute les secrets que tu lui donnes **en gardant tes commentaires**.
- **Garde-fou** : `./dot start` refuse un réglage de `env` qui ressemble à un secret (`…_API_KEY`, `…TOKEN`…), ainsi qu'une clé en clair dans `model`.
- **Le fichier contient tes secrets en clair** : il est créé lisible par toi seul. Garde-le comme un trousseau de clés.

**Ouvrir un `.dot` d'un double-clic** : `./dot associer` (Linux) associe les fichiers `.dot` à l'application. Un double-clic **lance toujours le dot**, puis fait ce que dit `onclic` : `chat` ouvre la conversation dans un terminal, `none` ne fait rien de plus (une autre application, par exemple, prend la main).

## Démarrer

```bash
./dot build                    # construit l'image (une fois, puis à chaque mise à jour du code)
./dot create travail           # crée dots/travail/ avec un travail.dot à remplir
                               #   (--dans ~/ailleurs : ailleurs ; --depuis autre : copie vierge d'un autre dot)
./dot @travail start           # lance son coffre, puis le dot
./dot @travail chat            # lui parler
```

Il faut docker ou podman. Le script prend celui qui est installé ; on peut forcer avec `DOT_ENGINE=docker`.

## Viser un dot

Toutes les commandes d'un dot acceptent, en premier argument :
- `@nom` : un dot déjà connu de l'application (elle tient la liste de ceux qu'elle a vus, dans `~/.local/share/dots/`) ;
- un **chemin** : son dossier ou son fichier `.dot` (`./dot ~/ailleurs/travail/travail.dot start`) ;
- rien : le dot choisi avec `./dot use`, ou le seul connu.

```bash
./dot list                     # les dots connus, et lesquels tournent (--json pour un programme)
./dot use travail              # le dot par défaut
./dot copie travail perso [--vierge]
./dot remove travail --yes     # efface son dossier entier
```

`DOTS_HOME` change l'endroit où `./dot create` range les nouveaux dots (par défaut `dots/`, hors git).

## Les commandes

| Commande | Rôle |
|---|---|
| `./dot build` | construire l'image (commune à tous les dots) |
| `./dot create`, `copie`, `list`, `use`, `remove` | gérer ses dots |
| `./dot associer` | ouvrir les fichiers `.dot` d'un double-clic (Linux) |
| `./dot start` / `./dot stop` | allumer / éteindre le dot et son coffre |
| `./dot open` | ce que fait le double-clic : lancer le dot, puis `onclic` |
| `./dot chat` | parler au dot depuis ta machine |
| `./dot ask "…"` | une question, la réponse s'affiche |
| `./dot send fichier "…"` | lui déposer un fichier |
| `./dot livrables` | ce qu'il a produit pour toi |
| `./dot secret` | répondre à une demande de secret du coffre |
| `./dot veilleur install` | allumer / éteindre le dot depuis Telegram (voir plus bas) |
| `./dot suivre` | le run de travail en cours, en direct |
| `./dot attach` | son terminal pi en direct (`Ctrl-b d` pour en sortir sans l'arrêter ; interface `tui`) |
| `./dot rpc` | connecteur RPC (interface `rpc`) |
| `./dot shell` | un shell dans son environnement |
| `./dot journal` | ce qu'il a fait (`-p` problèmes, `-f` en direct, `--runs`, `--reseau`, ou une date) |
| `./dot doctor` | diagnostic complet |
| `./dot status [--json]` / `./dot logs` | en marche ou non / sortie brute des conteneurs |
| `./dot test` | tests automatiques |

## Les réglages (`env` du fichier `.dot`)

Valeurs par défaut entre parenthèses :

| Variable | Rôle |
|---|---|
| `DOT_PROVIDER`, `DOT_MODEL`, `DOT_THINKING` | le modèle (un provider connu de pi, ou déclaré dans `model`) |
| `DOT_INTERFACE` | `tui` ou `rpc` (voir plus bas) |
| `TELEGRAM_OWNER_ID` | ton identifiant Telegram ; vide : pas de Telegram |
| `DOT_MEMORY`, `DOT_CPUS`, `DOT_PIDS` | plafonds du conteneur (8g, 4, 2048) |
| `DOT_RECHECK_MINUTES` | un objectif dont le plan n'a rien changé n'est réexaminé qu'après ce délai (60) |
| `DOT_RUN_MINUTES` | durée maximale d'un run de travail (30) |
| `DOT_MAX_RUNS` | runs sur un même todo avant de demander de l'aide (3) |
| `DOT_LOOP_REPEATS` | même appel d'outil répété dans un run : boucle, le run est arrêté (5) |
| `DOT_REVIEW_DAYS` | rythme du bilan du dot (7 ; 0 = jamais) |
| `DOT_LOG_DAYS` | durée de conservation du journal (30) |
| `TZ` | fuseau horaire des tâches planifiées |

## Interface : terminal ou RPC

`DOT_INTERFACE` :
- `tui` (par défaut) : le pi de conversation tourne dans un terminal, qu'on rejoint avec `./dot attach` ;
- `rpc` : il tourne en mode RPC derrière un relais, joignable par un socket (`state/channel/rpc.sock`). Le protocole est **celui de `pi --mode rpc`**, inchangé : un programme qui sait piloter pi en RPC pilote un dot en lançant `./dot @nom rpc` à la place de `pi --mode rpc` (les options passées sont ignorées : la configuration appartient au dot). Plusieurs clients peuvent se connecter en même temps ; chacun reçoit ses réponses et tous reçoivent les événements. Une demande à l'interface (confirmation, choix) va à tous, la première réponse l'emporte ; sans client connecté, elle est annulée pour que le dot ne reste jamais bloqué.

Dans les deux cas, Telegram, `./dot chat` et le reste fonctionnent.

## Faire gérer des dots par un autre agent

`integrations/pi-skill-dots/SKILL.md` est un skill pi d'exemple : installé dans un autre agent pi (avec `DOTS_CLI` pointant vers le script `dot`), il lui permet de créer, allumer, éteindre, lister des dots et leur parler. Il ne s'appuie que sur le script `dot` et ses sorties `--json`.

## Parler au dot

Deux canaux, **une seule conversation** (même mémoire, même plan) : tu peux commencer sur ton téléphone et continuer au terminal. Ses messages spontanés (`notify`) arrivent sur les deux.

**Depuis ta machine** : `./dot chat`. Si le dot est éteint, `./dot chat` et `./dot ask` proposent de l'allumer. Les messages passent par `state/channel/`. En plus des commandes du dot, le chat a les siennes : `/send fichier [message]`, `/secret`, `/allumer`, `/eteindre`, `/quit`.

**Depuis Telegram** : un bot privé, qui n'écoute que toi (`TELEGRAM_OWNER_ID`).

### Les commandes : les mêmes partout, et elles évoluent avec le dot

| Commande | Rôle |
|---|---|
| `/aide` | toutes les commandes du moment |
| `/status`, `/plan` | ce qu'il fait ; ses objectifs et todos |
| `/suivre` | le run en cours, en direct (sur Telegram : un message mis à jour au fil du run ; s'il n'y a rien en cours, il attend le prochain pendant 10 minutes) |
| `/journal`, `/problemes` | ce qu'il a fait aujourd'hui ; les problèmes des dernières 24 h |
| `/doctor`, `/budget` | diagnostic ; budget de contexte |
| `/livrables`, `/livrable nom` | ses derniers livrables ; en recevoir un (en pièce jointe sur Telegram) |
| `/pause`, `/resume` | suspendre ou reprendre son autonomie |
| `/new`, `/allumer`, `/eteindre` | nouvelle conversation ; allumer ou éteindre le dot |

Ces commandes sont instantanées : elles ne passent pas par le modèle. S'y ajoutent **celles que le dot se crée** : chacun de ses skills, et chaque commande déclarée par une extension qu'il s'est écrite, devient une commande (`/nom_du_skill`). Quand il crée, modifie ou supprime un skill ou une extension, il se recharge de lui-même dès qu'il est inactif. La commande apparaît alors (ou disparaît) dans `/aide`, dans `./dot chat` et dans le menu du bot Telegram.

**Le voir travailler** : pendant chaque run de travail, le dot tient un tableau de bord (`state/channel/live.json`) : l'objectif et le todo, la durée, les tours, les jetons, et chaque outil appelé, dit en clair (« commande : … », « lit … », « ketch · search : … »). `./dot suivre` l'affiche en direct dans ton terminal, run après run ; `/suivre` le montre sur Telegram et dans le chat.

**Récupérer son travail** : ce qu'il produit pour toi (rapport, export, document) va dans `state/livrables/`, un dossier que tu ouvres avec ton explorateur de fichiers ou avec `./dot livrables`. Sur Telegram, il te l'envoie aussi en pièce jointe quand c'est utile.

### Allumer et éteindre à distance : le veilleur

Un dot éteint ne lit plus rien. Pour `/allumer` depuis Telegram, il faut le **veilleur**, un petit programme qui tourne sur ta machine, hors du dot :
- dot **éteint** : il écoute Telegram à sa place, rallume le dot sur `/allumer`, et répond « je suis éteint » au reste ;
- dot **allumé** : il n'écoute pas Telegram (un bot n'a qu'un lecteur, le dot) ; il attend seulement que le dot lui transmette un `/eteindre`.

Il ne fait que lire un petit fichier toutes les 10 secondes : quelques millisecondes de CPU par minute, environ 10 Mo de mémoire.

```bash
./dot veilleur install     # service de ta session (Linux, systemd) : il démarre avec elle
./dot veilleur status
./dot veilleur uninstall
./dot veilleur run         # au premier plan, sans l'installer
```

## Le coffre : réseau et secrets

Le dot n'a **aucun accès direct au réseau**. Il vit sur un réseau interne où il ne voit qu'un seul autre conteneur : `dot-vault`, le coffre.

- **Internet** passe par le coffre, qui sert de proxy. pi, `curl`, `git`, `pip`, `npm`, `apt`, Node et le navigateur l'utilisent déjà.
- **Réseau local et machine hôte** : refusés, sauf les adresses listées dans `allow` et les serveurs nommés par un secret.
- **Secrets** : le dot ne connaît que leurs noms. Il écrit `{{NOM}}` dans ses requêtes, envoyées par `http://dot-vault:8080/https/<serveur>/…`, et le coffre met la vraie valeur au passage.

### Les secrets : une liste nom → valeur (le nœud `vault` du fichier `.dot`)

```yaml
vault:
  secrets:
    MODEL_KEY:        { value: "sk-…",     hosts: [host.docker.internal:8080] }
    TELEGRAM_TOKEN:   { value: "123456:…", hosts: [api.telegram.org] }
    SERVICE_USER:     { value: "moi@…",    hosts: ["*.example.com"], readOnly: true }
    SERVICE_PASSWORD: { value: "…",        hosts: ["*.example.com"], readOnly: true }
  allow: []
```

| Champ | Rôle |
|---|---|
| `value` | la valeur (ou `oauth` : `clientId`, `clientSecret`, `refreshToken`, `tokenUrl`, pour un jeton que le coffre renouvelle lui-même) |
| `hosts` | **obligatoire** : les seuls serveurs vers lesquels ce secret peut partir. Sans ça, le dot pourrait l'envoyer n'importe où |
| `readOnly` | facultatif : une requête qui porte ce secret ne peut que lire (`GET`, `HEAD`, `OPTIONS`, `PROPFIND`, `REPORT`) |

Dans une requête du dot : `Authorization: Bearer {{MODEL_KEY}}`, ou `Authorization: Basic {{basic:SERVICE_USER:SERVICE_PASSWORD}}`. Les marqueurs marchent aussi dans l'adresse (`/bot{{TELEGRAM_TOKEN}}/…`).

Les mails (IMAP) ne sont pas du web : le coffre les lit lui-même, en lecture seule (`POST http://dot-vault:8080/_vault/mail`), avec un identifiant et un mot de passe donnés en `{{NOM}}`. Il ouvre les dossiers en consultation et ne marque rien comme lu.

### Ajouter un secret : c'est le dot qui le demande

Tu n'as pas à éditer le nœud `vault` toi-même. Quand il manque un secret au dot pour faire ce que tu lui demandes, il le demande au coffre (outil `secret`) :

1. Le coffre, et non l'IA, te pose la question, **sur Telegram et sur ta machine** : à quoi servira le secret, vers quels serveurs il pourra partir, en lecture seule ou non.
2. Tu réponds :
   - sur Telegram, le coffre intercepte ta réponse avant qu'elle n'atteigne le dot, et **efface ton message du fil** ;
   - sur ta machine, avec `./dot secret` (ou `/secret` dans le chat), ta saisie ne s'affiche pas et va **directement au coffre**, par une porte qui n'écoute qu'à l'intérieur de son conteneur. Le dot ne peut pas la joindre, et la valeur ne passe jamais par `state/`.
   La première réponse l'emporte ; `/annuler` refuse.
3. Le coffre enregistre, te le confirme et prévient le dot. Il n'y a rien à redémarrer.

Pour qu'un secret existant serve aussi vers un autre serveur, le dot demande un **élargissement** : tu réponds oui ou non.

Une demande à la fois ; elle survit à un redémarrage du coffre et expire au bout de 30 minutes. Pendant une demande, les commandes du bot passent normalement au dot.

**Limites** :
- un service qui exige une autorisation dans un navigateur (OAuth) ne se configure pas ainsi : son secret s'ajoute à la main dans le nœud `vault` du fichier `.dot` ;
- le jeton Telegram (c'est le canal lui-même) se change à la main ;
- ce que le coffre ne protège pas : ce que le dot voit ou fait avec ses accès. Donne-lui des comptes et des droits à sa mesure (lecture seule quand c'est possible, son propre compte git…).

## Ce qu'il y a dans l'environnement

- **OS** : Debian avec Node 24, Python 3, git, ripgrep, fd, jq, tmux. `sudo` sans mot de passe : le dot installe lui-même ce qui lui manque.
- **Agent** : pi.
- **Outils** : ketch (recherche web et lecture de pages, sans clé API), Playwright (un vrai navigateur Chromium, dont le profil est gardé), et les outils du dot décrits plus bas.
- **Extensions pi du dépôt** :
  - `dot` : l'autonomie, le plan, la mémoire, le budget, le diagnostic ;
  - `dot-telegram` et `dot-local` : les deux canaux ;
  - [ctx-optimizer](https://github.com/burnoutIA/ctx_optimizer), fixée sur un commit : elle distille les vieux résultats d'outils et retire le raisonnement passé, pour que le dot travaille au lieu de compacter.

## Comment le dot travaille

Le dot avance par **objectifs** (outil `objective`) et **todos** (outil `todo`). Le plan est dans `state/memory/plan.json`, avec une vue lisible dans `state/memory/PLAN.md`.

Toutes les 15 s, un battement lit le plan **sans passer par le modèle**. Il ne lance un run de travail que s'il y a quelque chose à faire :

| Situation | Ce qui se passe |
|---|---|
| Un événement : tâche planifiée échue (`schedule`), veille qui a changé (`watch`), fichier posé dans `state/inbox/` | run sur l'événement |
| Un todo en cours (par exemple coupé par un arrêt) ou un todo prêt | run sur ce todo |
| Un objectif actif sans aucun todo ouvert | run de plan : le dot constate que l'objectif est atteint, ou planifie la suite |
| Objectif atteint, todos en attente de toi, rien de prévu | rien : le modèle n'est pas sollicité |

- **Sessions** : chaque run est un pi lancé à part, dans la session de son objectif. Ta conversation avec le dot reste séparée et ne reçoit qu'un court compte-rendu par run.
- **File** : un seul run à la fois, et seulement quand la conversation est inactive. Tes messages passent d'abord.
- **Reprise** : un todo coupé par un arrêt est repris au démarrage ; une tâche planifiée échue pendant un arrêt est lancée au démarrage.
- **Garde-fous** :
  - un todo non terminé après `DOT_MAX_RUNS` runs passe en attente, et le dot te demande de l'aide ;
  - un plan qui ne change rien n'est réexaminé qu'après `DOT_RECHECK_MINUTES` ;
  - un run est coupé après `DOT_RUN_MINUTES` ;
  - un même appel d'outil répété `DOT_LOOP_REPEATS` fois dans un run, à la suite ou non, arrête le run.
- **Panne du modèle** : un run qui échoue parce que le modèle ne répond pas n'est pas compté comme un échec. Le travail attend, le dot te prévient une fois, réessaie de plus en plus espacé (2, 4, 8 puis 15 min), et te prévient quand le modèle revient.
- **`notify`** : le dot ne t'écrit de lui-même que s'il a du nouveau ou besoin de toi, sans limite de nombre. Un message qui redit la même chose qu'un message des 6 dernières heures n'est pas envoyé.

## Comment le dot s'améliore

- **Mémoire** : `state/memory/MEMORY.md`, lue au début de chaque session (conversation et runs). C'est le lien entre ses sessions : il y note avec `remember` ce qui servira ailleurs (une décision, le fonctionnement d'un service, ce qui a été abandonné), et retire avec `forget` ce qui n'est plus vrai.
- **Skills** : il s'écrit ses propres skills (`state/agent/skills/`). Un skill mal formé (sans en-tête `name` / `description`, donc ignoré par pi) lui est signalé pour qu'il le corrige.
- **Extensions** : il peut aussi s'écrire des extensions pi (`state/agent/extensions/`), gardées d'un démarrage à l'autre. Seules les extensions du dépôt et ses consignes sont remplacées à chaque démarrage.
- **Budget de contexte** : chaque outil déclaré au modèle coûte des jetons à chaque appel. Le dot connaît son modèle et sa fenêtre, compte ce qu'il utilise vraiment (outils et skills, par jour), et décide lui-même avec l'outil `budget` ce qui reste déclaré (`direct`) ou n'est chargé qu'à la demande (`deferred`, trouvé par `tool_search`). Ses outils de base restent toujours déclarés. Ses choix sont réversibles : un outil différé reste utilisable et son usage est compté ; s'il le recharge souvent, il en est averti.
- **Bilan** : tous les `DOT_REVIEW_DAYS` jours (le premier dès le lendemain), il vérifie si ses changements précédents ont tenu leurs promesses, corrige la cause de ses échecs de la période, tient compte de tes retours, ajuste ses outils et allège ses skills. Il note chaque changement avec sa mesure de départ, pour comparer au bilan suivant.
- **Retours** : quand il te livre quelque chose de nouveau (un skill, un rapport régulier, un objectif atteint), il te demande ton avis en une question courte, et retient ta réponse.

## Journal : savoir ce qui s'est passé

Le dot tient un journal technique horodaté, avec un fichier par jour dans `state/logs/`. On le lit depuis la machine :

```bash
./dot journal               # aujourd'hui
./dot journal 2026-10-21    # un autre jour
./dot journal -p            # seulement les problèmes
./dot journal -f            # en direct
./dot journal --runs        # un run par ligne : début, fin, durée, résultat
./dot journal --reseau      # avec chaque sortie réseau vue par le coffre
```

Ce qui est noté :
- **les runs** : début, fin, durée, tours, outils appelés, jetons, erreur éventuelle ;
- **les problèmes** : boucles (arrêtées), todos bloqués, runs coupés ou tués faute de mémoire, pannes et retours du modèle, messages bloqués, conflits Telegram (un autre programme qui lit le même bot) ;
- **la vie du dot** : démarrages et arrêts (dont à distance ⏻), plan, événements, `notify`, mémoire, choix de budget ;
- **le coffre** : demandes de secrets, refus et erreurs, lectures de mails, et chaque sortie réseau avec `--reseau`.

## Diagnostic

`./dot doctor` vérifie chaque maillon et dit ce qui est en panne (❌) ou à surveiller (⚠️) :
- **côté machine** : le moteur, l'image à jour par rapport au code, la configuration, aucun secret visible du dot, le coffre, le veilleur et le dot en marche ;
- **côté dot** : le coffre, internet, le modèle, Telegram (dont des messages en attente que personne ne lit), le battement, un run bloqué, les todos en attente, les skills non chargés, la mémoire, la mémoire vive, le disque, et les problèmes du journal sur 24 heures.

Le dot a le même diagnostic (outil `doctor`, sur une période réglable) pour se vérifier lui-même.

## Tests

`./dot test` lance les tests automatiques dans l'image, sur le code du dépôt (sans reconstruire) :
- **le cœur** : plan, échéances, détection de panne du modèle, mémoire, skills mal formés, comptage d'usage et choix des outils déclarés ;
- **le coffre de bout en bout**, avec un faux service et un faux Telegram : marqueurs, serveurs autorisés, lecture seule, adresses privées, demande de secret (interception, enregistrement, effacement, annulation, élargissement, redémarrage), et réponse depuis la machine.

Pas encore testés automatiquement : la lecture IMAP, les runs et le battement eux-mêmes.

## La vie du dot (`state/`)

```text
state/agent/       configuration de pi et sessions (ses skills et extensions sont à côté de state/)
state/memory/      MEMORY.md, JOURNAL.md, plan.json et PLAN.md, tâches, veilles, usage, état
state/workspace/   son dossier de travail (files/ : les fichiers que tu lui as déposés)
state/livrables/   ce qu'il a produit pour toi
state/channel/     le canal local (messages, réponses, notifications)
state/inbox/       boîte de dépôt
state/logs/        le journal
state/browser/     profil du navigateur
```

Supprimer `state/` remet le dot à zéro, en gardant ses accès, ses skills et ses extensions.

## Structure du dépôt

```text
Containerfile                   l'image : OS, outils, pi, navigateur, ketch, ctx-optimizer
dot                             toutes les commandes
image/entrypoint.sh             démarrage : config de pi depuis env, pi dans tmux ou derrière le relais RPC
image/dotfile.mjs               le fichier .dot : lecture, extraction de env et model, mise à jour du vault
image/defaults/                 consignes du dot, serveurs MCP, modèles de mémoire
image/extensions/dot/           autonomie : plan, battement, runs, schedule, watch, mémoire, budget, doctor, secret
image/extensions/dot-telegram/  canal Telegram (via le coffre)
image/extensions/dot-local/     canal local (state/channel)
image/vault/                    le coffre : proxy filtré, secrets remplacés au passage, demandes, IMAP
image/doctor.mjs                diagnostic, côté dot
tools/chat.py                   le canal local, côté machine (chat, ask, send, secret, livrables)
tools/veilleur.py               le veilleur (allumer / éteindre depuis Telegram)
tools/suivre.py                 le run en cours, en direct
tools/journal.py                lecture du journal
image/hub.mjs                   le relais RPC (interface rpc)
tools/rpc.py                    le connecteur RPC, côté machine
integrations/pi-skill-dots/     skill d'exemple : faire gérer des dots par un autre agent pi
tests/                          tests automatiques
```
