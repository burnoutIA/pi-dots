# dots

Un dot est un agent [pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) autonome et proactif. Il vit dans un environnement clos (un conteneur docker ou podman), livré déjà préconfiguré, avec son propre OS et ses outils. On peut lui demander à peu près tout : il se débrouille. La seule règle imposée est la sécurité : tout ce qui sort, et tous les secrets, passent par son **coffre**.

Il tourne quand on l'allume. Quand on l'éteint, il reprend là où il en était au démarrage suivant. Le périmètre du projet est dans [PERIMETRE.md](PERIMETRE.md).

## Démarrer

```bash
cp .env.example .env                              # provider, modèle, rythme : rien de secret
cp config/vault.example.json config/vault.json    # les premiers secrets : clé du modèle, jeton Telegram
cp config/models.example.json config/models.json  # si ton provider n'est pas connu de pi
./dot build                                       # construit l'image (une fois, puis à chaque mise à jour)
./dot start                                       # lance le coffre, puis le dot
./dot chat                                        # lui parler
```

Il faut docker ou podman. Le script prend celui qui est installé ; on peut forcer avec `DOT_ENGINE=docker`.

## Les commandes

| Commande | Rôle |
|---|---|
| `./dot build` | construire l'image |
| `./dot start` / `./dot stop` | allumer / éteindre le dot et son coffre (l'état reste dans `state/`) |
| `./dot chat` | parler au dot depuis ta machine |
| `./dot ask "…"` | une question, la réponse s'affiche |
| `./dot send fichier "…"` | lui déposer un fichier |
| `./dot livrables` | ce qu'il a produit pour toi |
| `./dot secret` | répondre à une demande de secret du coffre |
| `./dot veilleur install` | allumer / éteindre le dot depuis Telegram (voir plus bas) |
| `./dot suivre` | le run de travail en cours, en direct |
| `./dot attach` | son terminal pi en direct (`Ctrl-b d` pour en sortir sans l'arrêter) |
| `./dot shell` | un shell dans son environnement |
| `./dot journal` | ce qu'il a fait (`-p` problèmes, `-f` en direct, `--runs`, `--reseau`, ou une date) |
| `./dot doctor` | diagnostic complet |
| `./dot test` | tests automatiques |
| `./dot status` / `./dot logs` | en marche ou non / sortie brute des conteneurs |

## Configuration (jamais versionnée)

| Fichier | Lu par | Contenu |
|---|---|---|
| `.env` | le dot | provider et modèle (`DOT_PROVIDER`, `DOT_MODEL`), `TELEGRAM_OWNER_ID`, rythme, ressources. **Aucun secret** : `./dot start` refuse de démarrer s'il en voit un |
| `config/vault.json` | le coffre seul | la liste des secrets : nom → valeur, avec les serveurs où chacun a le droit d'aller |
| `config/models.json` | le dot | facultatif : les providers à déclarer à pi, avec `baseUrl` passant par le coffre et `apiKey: "{{MODEL_KEY}}"` |

Les réglages de `.env` (valeurs par défaut entre parenthèses) :

| Variable | Rôle |
|---|---|
| `DOT_MEMORY`, `DOT_CPUS`, `DOT_PIDS` | plafonds du conteneur (8g, 4, 2048) |
| `DOT_RECHECK_MINUTES` | un objectif dont le plan n'a rien changé n'est réexaminé qu'après ce délai (60) |
| `DOT_RUN_MINUTES` | durée maximale d'un run de travail (30) |
| `DOT_MAX_RUNS` | runs sur un même todo avant de demander de l'aide (3) |
| `DOT_LOOP_REPEATS` | même appel d'outil répété dans un run : boucle, le run est arrêté (5) |
| `DOT_REVIEW_DAYS` | rythme du bilan du dot (7 ; 0 = jamais) |
| `DOT_LOG_DAYS` | durée de conservation du journal (30) |
| `TZ` | fuseau horaire des tâches planifiées |

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

### Les secrets : une liste nom → valeur

```json
{
  "secrets": {
    "MODEL_KEY":        { "value": "sk-…",       "hosts": ["host.docker.internal:8080"] },
    "TELEGRAM_TOKEN":   { "value": "123456:…",   "hosts": ["api.telegram.org"] },
    "SERVICE_USER":     { "value": "moi@…",      "hosts": ["*.example.com"], "readOnly": true },
    "SERVICE_PASSWORD": { "value": "…",          "hosts": ["*.example.com"], "readOnly": true }
  },
  "allow": []
}
```

| Champ | Rôle |
|---|---|
| `value` | la valeur (ou `oauth` : `clientId`, `clientSecret`, `refreshToken`, `tokenUrl`, pour un jeton que le coffre renouvelle lui-même) |
| `hosts` | **obligatoire** : les seuls serveurs vers lesquels ce secret peut partir. Sans ça, le dot pourrait l'envoyer n'importe où |
| `readOnly` | facultatif : une requête qui porte ce secret ne peut que lire (`GET`, `HEAD`, `OPTIONS`, `PROPFIND`, `REPORT`) |

Dans une requête du dot : `Authorization: Bearer {{MODEL_KEY}}`, ou `Authorization: Basic {{basic:SERVICE_USER:SERVICE_PASSWORD}}`. Les marqueurs marchent aussi dans l'adresse (`/bot{{TELEGRAM_TOKEN}}/…`).

Les mails (IMAP) ne sont pas du web : le coffre les lit lui-même, en lecture seule (`POST http://dot-vault:8080/_vault/mail`), avec un identifiant et un mot de passe donnés en `{{NOM}}`. Il ouvre les dossiers en consultation et ne marque rien comme lu.

### Ajouter un secret : c'est le dot qui le demande

Tu n'as pas à éditer `vault.json`. Quand il manque un secret au dot pour faire ce que tu lui demandes, il le demande au coffre (outil `secret`) :

1. Le coffre, et non l'IA, te pose la question, **sur Telegram et sur ta machine** : à quoi servira le secret, vers quels serveurs il pourra partir, en lecture seule ou non.
2. Tu réponds :
   - sur Telegram, le coffre intercepte ta réponse avant qu'elle n'atteigne le dot, et **efface ton message du fil** ;
   - sur ta machine, avec `./dot secret` (ou `/secret` dans le chat), ta saisie ne s'affiche pas et va **directement au coffre**, par une porte qui n'écoute qu'à l'intérieur de son conteneur. Le dot ne peut pas la joindre, et la valeur ne passe jamais par `state/`.
   La première réponse l'emporte ; `/annuler` refuse.
3. Le coffre enregistre, te le confirme et prévient le dot. Il n'y a rien à redémarrer.

Pour qu'un secret existant serve aussi vers un autre serveur, le dot demande un **élargissement** : tu réponds oui ou non.

Une demande à la fois ; elle survit à un redémarrage du coffre et expire au bout de 30 minutes. Pendant une demande, les commandes du bot passent normalement au dot.

**Limites** :
- un service qui exige une autorisation dans un navigateur (OAuth) ne se configure pas ainsi : son secret s'ajoute à la main dans `vault.json` ;
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

## État du dot (`state/`, hors git)

```text
state/agent/       configuration de pi, sessions, skills et extensions du dot
state/memory/      MEMORY.md, JOURNAL.md, plan.json et PLAN.md, tâches, veilles, usage, état
state/workspace/   son dossier de travail (files/ : les fichiers que tu lui as déposés)
state/livrables/   ce qu'il a produit pour toi
state/channel/     le canal local (messages, réponses, notifications)
state/inbox/       boîte de dépôt
state/logs/        le journal
state/browser/     profil du navigateur
```

Supprimer `state/` remet le dot à zéro.

## Structure du dépôt

```text
Containerfile                   l'image : OS, outils, pi, navigateur, ketch, ctx-optimizer
dot                             toutes les commandes
image/entrypoint.sh             démarrage : config de pi depuis .env, pi dans tmux
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
tests/                          tests automatiques
```
