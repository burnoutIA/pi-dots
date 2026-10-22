# dots

Un dot est un agent [pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) autonome et proactif. Il vit dans un environnement clos (un conteneur docker ou podman) livré déjà préconfiguré.

Il tourne quand on lance l'environnement. Quand on l'arrête, il reprend là où il en était au lancement suivant. Le périmètre du projet est dans [PERIMETRE.md](PERIMETRE.md).

## Démarrer

```bash
cp .env.example .env                              # provider, modèle, rythme : rien de secret
cp config/vault.example.json config/vault.json    # les secrets : clés d'API, jeton Telegram
cp config/models.example.json config/models.json  # si ton provider n'est pas connu de pi
./dot build                       # construit l'image (une fois, puis à chaque mise à jour)
./dot start                       # lance le coffre, puis le dot
./dot attach                      # son terminal pi (Ctrl-b d pour en sortir sans l'arrêter)
./dot stop                        # arrête tout ; l'état reste dans state/
```

Il faut docker ou podman. Le script prend celui qui est installé ; on peut forcer avec `DOT_ENGINE=docker`.

## Configuration (jamais versionnée)

| Fichier | Lu par | Contenu |
|---|---|---|
| `.env` | le dot | provider et modèle (`DOT_PROVIDER`, `DOT_MODEL`), `TELEGRAM_OWNER_ID`, rythme, ressources. **Aucun secret** : `./dot start` refuse de démarrer s'il en voit un |
| `config/vault.json` | le coffre seul | les routes vers les providers avec leurs en-têtes secrets, le jeton Telegram, les adresses privées autorisées |
| `config/models.json` | le dot | facultatif : les providers à déclarer à pi, avec `baseUrl` pointant vers le coffre (`http://dot-vault:8080/<route>`) et `apiKey: "vault"` |

## Le coffre : réseau et secrets

Le dot n'a **aucun accès direct au réseau**. Il vit sur un réseau interne où il ne voit qu'un seul autre conteneur : `dot-vault`, le coffre.

- **Internet** passe par le coffre, qui sert de proxy. pi, `curl`, `git`, `pip`, `npm`, `apt`, Node et le navigateur l'utilisent déjà.
- **Réseau local et machine hôte** : le coffre refuse les adresses privées, sauf celles listées dans `allow` de `config/vault.json`. Chaque refus est noté au journal.
- **Secrets** : pour joindre un provider, le dot appelle une route du coffre (`http://dot-vault:8080/local/...`). Le coffre y ajoute lui-même la clé et transmet à l'adresse réelle, qui peut être ton serveur d'inférence sur la machine hôte. Le dot connaît le nom de la route, jamais la clé, même avec `sudo`.

Exemple de `config/vault.json` pour un serveur d'inférence sur la machine hôte :

```json
{
  "routes": {
    "local": {
      "upstream": "http://host.docker.internal:4748/v1",
      "headers": { "Authorization": "Bearer ta-cle" }
    }
  },
  "telegram": { "token": "123456:jeton-du-bot" },
  "allow": []
}
```

Ce que le coffre ne protège pas : ce que le dot voit ou fait avec ses accès. Donne-lui des comptes et des droits à sa mesure (lecture seule quand c'est possible, son propre compte git…).

## Ce qu'il y a dans l'environnement

- **OS** : Debian avec Node 24, Python 3, git, ripgrep, fd, jq, tmux. `sudo` sans mot de passe : le dot installe lui-même ce qui lui manque.
- **Agent** : pi.
- **Outils** :
  - **ketch** : recherche web et lecture de pages, sans clé API ;
  - **Playwright** : un vrai navigateur Chromium, dont le profil est gardé d'un démarrage à l'autre ;
  - **Telegram**.
- **Contexte** : l'extension [ctx-optimizer](https://github.com/burnoutIA/ctx_optimizer), fixée sur un commit. Elle distille les vieux résultats d'outils et retire le raisonnement passé, pour que le dot travaille au lieu de compacter.
- **Autonomie** : l'extension `dot`, décrite ci-dessous.

## Comment le dot travaille

Le dot avance par **objectifs** (outil `objective`) et **todos** (outil `todo`). Le plan est dans `state/memory/plan.json`, avec une vue lisible dans `state/memory/PLAN.md`.

Toutes les 15 s, un battement lit le plan **sans passer par le modèle**. Il ne lance un run de travail que s'il y a quelque chose à faire :

| Situation | Ce qui se passe |
|---|---|
| Un événement : tâche planifiée échue (`schedule`), veille qui a changé (`watch`), fichier posé dans `state/inbox/` | run sur l'événement |
| Un todo en cours (par exemple coupé par un arrêt) ou un todo prêt | run sur ce todo |
| Un objectif actif sans aucun todo ouvert | run de plan : le dot constate que l'objectif est atteint, ou planifie la suite |
| Objectif atteint, todos en attente de toi, rien de prévu | rien : le modèle n'est pas sollicité |

- **Sessions** : chaque run est un pi lancé à part, dans la session de son objectif (une session par objectif). Ta conversation avec le dot reste séparée et ne reçoit qu'un court compte-rendu par run.
- **File** : un seul run à la fois, et seulement quand la conversation est inactive. Tes messages passent d'abord.
- **Garde-fous** :
  - un todo non terminé après `DOT_MAX_RUNS` runs passe en attente, et le dot te demande de l'aide ;
  - un plan qui ne change rien n'est réexaminé qu'après `DOT_RECHECK_MINUTES` ;
  - un run est coupé après `DOT_RUN_MINUTES`.
- **`notify`** : le dot te prévient quand il travaille de lui-même (sur Telegram, ou dans `state/memory/NOTIFICATIONS.md`).

## Journal : savoir ce qui s'est passé

Le dot tient un journal technique horodaté, avec un fichier par jour dans `state/logs/`. Les fichiers de plus de 30 jours sont supprimés (`DOT_LOG_DAYS`). On le lit depuis la machine hôte :

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
- **les boucles probables** : le même appel d'outil répété 5 fois de suite (`DOT_LOOP_REPEATS`), avec l'heure ;
- **les blocages** : un todo passé en attente après trop de runs ;
- **les runs coupés** (trop longs) ou tués par le système (mémoire) ;
- **les arrêts et redémarrages** de l'environnement et du pi de conversation ;
- **la vie du plan** (objectifs et todos créés, terminés, bloqués), les événements reçus et les `notify` ;
- **le coffre** : accès refusés et erreurs, et chaque sortie réseau avec `--reseau`.

## Telegram

- Ta réponse arrive quand c'est toi qui écris ; le reste du temps, le dot ne t'écrit qu'avec `notify`.
- Commandes :
  - `/status` : tâches, veilles et état de l'autonomie ;
  - `/pause` et `/resume` : suspendre ou reprendre l'autonomie ;
  - `/new` : nouvelle conversation.

## État du dot (`state/`, hors git)

```text
state/agent/       configuration de pi, sessions (conversations reprenables)
state/memory/      MEMORY.md, JOURNAL.md, plan.json et PLAN.md, tâches, veilles, état
state/workspace/   son dossier de travail
state/inbox/       boîte de dépôt
state/browser/     profil du navigateur
```

Supprimer `state/` remet le dot à zéro.

## Structure du dépôt

```text
Containerfile           l'image : OS, outils, pi, navigateur
dot                     lancer / arrêter / rejoindre
image/entrypoint.sh     démarrage : config de pi depuis .env, pi dans tmux
image/defaults/         consignes du dot, serveurs MCP, modèles de mémoire
image/extensions/dot/           autonomie : plan (objectifs, todos), battement, runs de travail, schedule, watch, boîte, notify
image/extensions/dot-telegram/  canal Telegram (via le coffre)
image/vault/vault.mjs           le coffre : proxy sortant filtré et relais à secrets
tools/journal.py                lecture du journal depuis la machine hôte
```
