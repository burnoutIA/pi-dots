---
name: dots
description: Créer, allumer, éteindre et interroger des dots (agents pi autonomes dans un environnement clos). À utiliser quand la personne veut un nouveau dot, savoir lesquels tournent, ou parler à l'un d'eux.
---

# Gérer des dots

Un dot est un agent pi autonome, dans son propre conteneur, avec un coffre pour ses secrets. Tout passe par le script `dot` du dépôt dots ; son chemin est dans la variable `DOTS_CLI` (sinon, demande-le à la personne).

## Ce qu'est un dot

Un dossier : `<nom>.dot` (en-tête, réglages, providers, secrets), `skills/`, `extensions/`, `state/` (sa vie). Copier le dossier sans `state/` donne un dot vierge.

## Voir les dots

```bash
"$DOTS_CLI" list --json          # [{name, running, vault, interface, dir, file, socket}, …]
"$DOTS_CLI" @nom status --json   # un seul dot
```

## Créer, copier, allumer, éteindre

```bash
"$DOTS_CLI" create nom [--dans dossier]   # un dot neuf, avec un nom.dot à remplir
"$DOTS_CLI" create nom --depuis autre     # une copie vierge d'un autre dot (sans sa vie, sans Telegram)
"$DOTS_CLI" copie autre nom [--vierge]    # copie complète (ou vierge)
"$DOTS_CLI" @nom start
"$DOTS_CLI" @nom stop
"$DOTS_CLI" remove nom --yes              # efface son dossier entier : demande toujours à la personne avant
```

Un nom : minuscules, chiffres et tirets. Un dot vierge garde les accès de celui qu'il copie ; il demandera lui-même les secrets qui lui manquent (sur la machine : `"$DOTS_CLI" @nom secret`).

## Lui parler

```bash
"$DOTS_CLI" @nom ask "message"         # une question, sa réponse sur la sortie standard
"$DOTS_CLI" @nom send fichier "message"
"$DOTS_CLI" @nom livrables             # ce qu'il a produit
```

Pour une conversation riche (texte en flux, outils appelés) : si le dot a `DOT_INTERFACE: rpc`, `"$DOTS_CLI" @nom rpc` parle le protocole de `pi --mode rpc` sur l'entrée et la sortie standard.

## Règles
- Ne lis jamais le fichier `.dot` d'un dot (il contient ses secrets) et ne demande jamais un secret dans la conversation : c'est le coffre du dot qui les demande.
- Avant `remove`, demande toujours confirmation à la personne.
