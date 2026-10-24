# Périmètre — dots

Un dot est un agent pi **autonome et proactif** qui vit dans un **environnement clos**, livré déjà préconfiguré.

On peut lui demander à peu près tout : il se débrouille, avec son propre OS et ses outils. La seule règle imposée est la sécurité : tout ce qui sort, et tous les secrets, passent par le coffre.

Le dépôt fournit trois choses :
- l'environnement ;
- l'agent ;
- ses outils.

L'utilisateur ne fournit que ses variables.

## 1. Environnement clos

- Une VM, un conteneur Docker ou autre : la forme reste à choisir, l'important est que l'environnement soit fermé.
- Il est livré avec l'OS et les outils dont l'agent a besoin, prêts à l'emploi.
- L'agent est libre à l'intérieur. Ce qui sort passe par des règles.
- Il tourne quand on le lance. À chaque lancement, l'agent **reprend** là où il en était : mémoire, objectifs, travail en cours.

## 2. L'agent : pi, préconfigurable

- **Provider** : n'importe lequel parmi ceux que pi sait déjà gérer (local, DeepSeek, etc.). Rien n'est propre à un provider dans le dépôt.
- **Configuration** : livrée par défaut, avec consignes, mémoire, sessions reprenables et outils activés.
- **Variables utilisateur** : provider, modèle, clés d'API, jeton et identifiant Telegram, etc.
  - Elles sont fournies au lancement.
  - Elles ne sont **jamais versionnées** : on versionne seulement un fichier d'exemple, et le vrai fichier est ignoré par git.

## 3. Outils

**Pour agir**
- Telegram : canal de discussion et de notifications.
- ketch : recherche web.
- Playwright : navigateur.
- Autres outils selon les besoins.

**Pour être autonome et proactif**
- **Heartbeat** : un battement régulier qui réveille l'agent pour qu'il décide quoi faire, même sans message.
- **Triggers** : réagir à des événements (un message, un fichier, un changement, une échéance).
- **Récurrences** : des tâches qui reviennent à intervalle ou à heure fixe.
- **Reprise** : retrouver et poursuivre le travail en cours après un arrêt.
- **Objectifs** : une liste que l'agent et l'utilisateur peuvent modifier à tout moment.

## Objectifs de l'agent

**Ouverts.** Ils ne sont pas définis par le projet, mais au fil de l'usage.

## Ce qui n'est pas le projet

Les usages d'une personne (un brief du matin, un skill agenda ou mail, tel service connecté…) ne font pas partie du dépôt : ce sont des demandes faites au dot, qu'il réalise lui-même. Ils vivent dans le dossier du dot (ses skills, son état, le coffre de son fichier `.dot`), jamais dans le code.

## À traiter plus tard

- Interagir avec le dot depuis l'OS hôte, autrement que par Telegram.
- Voir le dot travailler.

## Hors périmètre pour l'instant

- Plusieurs dots qui collaborent.
- Le choix et l'hébergement du modèle (c'est le rôle du provider).
