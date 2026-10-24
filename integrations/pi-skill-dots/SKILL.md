---
name: dots
description: Créer, allumer, éteindre et interroger des dots (agents pi autonomes dans un environnement clos). À utiliser quand la personne veut un nouveau dot, savoir lesquels tournent, ou parler à l'un d'eux.
---

# Gérer des dots

Un dot est un agent pi autonome, dans son propre conteneur, avec un coffre pour ses secrets. Tout passe par le script `dot` du dépôt dots ; son chemin est dans la variable `DOTS_CLI` (sinon, demande-le à la personne).

## Voir les dots

```bash
"$DOTS_CLI" list --json          # [{name, running, vault, interface, dir, socket}, …]
"$DOTS_CLI" @nom status --json   # un seul dot
```

## Créer, allumer, éteindre

```bash
"$DOTS_CLI" create nom                 # reprend la configuration du dot par défaut (modèle), sans Telegram
"$DOTS_CLI" create nom --from autre    # reprend celle d'un autre dot
"$DOTS_CLI" @nom start
"$DOTS_CLI" @nom stop
"$DOTS_CLI" remove nom --yes           # efface son état, sa mémoire et ses secrets : demande toujours à la personne avant
```

Un nom : minuscules, chiffres et tirets. Un nouveau dot n'a que l'accès au modèle ; il demandera lui-même les autres secrets à la personne (sur sa machine : `"$DOTS_CLI" @nom secret`).

## Lui parler

```bash
"$DOTS_CLI" @nom ask "message"         # une question, sa réponse sur la sortie standard
"$DOTS_CLI" @nom send fichier "message"
"$DOTS_CLI" @nom livrables             # ce qu'il a produit
```

Pour une conversation riche (texte en flux, outils appelés) : si le dot a `DOT_INTERFACE=rpc`, `"$DOTS_CLI" @nom rpc` parle le protocole de `pi --mode rpc` sur l'entrée et la sortie standard.

## Règles
- Ne lis jamais `config/vault.json` d'un dot et ne demande jamais un secret dans la conversation : c'est le coffre du dot qui les demande.
- Avant `remove`, demande toujours confirmation à la personne.
