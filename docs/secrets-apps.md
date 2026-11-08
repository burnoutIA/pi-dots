# Secrets : des apps à la place du relais

Note de conception, à relire avant de coder.

## Le problème

Aujourd'hui, le dot se sert d'un secret en écrivant `{{NOM}}` dans ses propres requêtes, envoyées par le relais du coffre (`http://dot-vault:8080/https/<serveur>/…`). Le coffre met la vraie valeur au passage et masque la réponse si la valeur y revient.

C'est le dot qui place le secret, donc il peut le placer là où il le relira :

- **écrire, puis relire** : il envoie `{{TOKEN}}` dans le corps d'un POST vers un serveur autorisé (une note, un fichier, un champ de profil), puis relit ce contenu par une autre requête, qui n'est pas masquée ;
- **une forme transformée** : le serveur renvoie la valeur en base64, coupée ou en partie, et le masquage ne la reconnaît pas ;
- **un autre serveur du même service** : le secret est écrit sur un serveur et relu sur un autre ;
- **une valeur très courte** (moins de 4 caractères), qui n'est jamais masquée.

Une fois la valeur connue, le dot peut l'envoyer n'importe où : le proxy sortant donne accès à internet, et le trafic HTTPS y passe en tunnel, illisible pour le coffre. Le risque concret est l'injection : une page ou un mail lu par le dot lui dicte de le faire.

## Le principe

**Le dot ne manipule plus aucun secret, même par son nom.** Il dispose de fonctions précises (`lire_factures(mois)`, `créer_ticket(titre)`), servies par des apps qui tournent hors de sa portée et détiennent elles-mêmes leurs secrets. Il reçoit le résultat, jamais ce qui a servi à l'obtenir.

Le projet le fait déjà pour un cas : la lecture des mails (`/_vault/mail`), où le coffre se connecte lui-même et ne rend que les messages.

## Ce qui sort du dot

| Chemin | Pour quoi | Secret |
|---|---|---|
| **Proxy sortant** (inchangé) | internet sans secret : pages web, `git`, `pip`, `npm`, `apt`, navigateur. Pas d'accès au réseau local, sauf `allow` | aucun |
| **Passerelle du modèle** | pi appelle `http://dot-vault:8080/model/…` sans clé ; le coffre envoie l'appel au fournisseur prévu dans le `.dot` et ajoute la clé. La file d'attente des appels et la découverte des modèles (`GET /models`) passent par là | ajouté par le coffre |
| **Passerelle Telegram** | l'extension Telegram appelle `http://dot-vault:8080/telegram/…` ; le coffre ajoute le jeton du bot | ajouté par le coffre |
| **Apps** | tous les autres services | détenus par l'app |

**Le relais à `{{NOM}}` disparaît.** Avec lui partent : la substitution dans les adresses, les en-têtes et le corps, `x-vault-body`, `{{basic:…}}`, et les consignes du dot qui en parlent.

## Une app

Une app est un serveur MCP : le dot découvre ses fonctions tout seul, et pi sait déjà parler MCP. Elle peut être écrite dans n'importe quel langage.

### Le cadre

Une app respecte un cadre, le même pour tous les langages, pour que sa relecture reste faisable :

- **les secrets par une seule porte** : l'app les demande au coffre, qui ne lui donne que ceux de son manifeste. Ils ne sont pas dans son environnement. C'est appliqué à l'exécution, quel que soit le langage ;
- **le code écrit par le dot, en sources seulement** : l'app est construite dans `dot-outils` à partir de ses sources, jamais livrée en binaire ;
- **une taille limite pour ce code** : `DOT_APP_MAX_CHARS` dans `env` du `.dot` (50 000 caractères par défaut, environ 1 200 lignes), pour que le relecteur le lise d'une traite. On compte tout ce que le dot a écrit ou copié dans l'app. Au-delà, l'app est refusée et le dot la découpe (une app par service) ;
- **les outils tiers sont des dépendances** : un outil existant dont l'app se sert (ketch, un client d'API officiel…) n'est pas compté dans la taille et n'est pas relu ligne à ligne. Il est figé à une version exacte, téléchargé depuis sa source officielle avec une somme de contrôle, et, pour lui seul, un binaire officiel est permis. Sa provenance et ses CVE sont vérifiées par le relecteur. Ce qui le contient, à défaut de relecture : les limites à l'exécution (il ne joint que les serveurs du manifeste, ses réponses sont masquées). C'est la confiance qu'on accorde déjà à ketch, Playwright et pi dans l'image.

Le reste (dépendances, constructions qui cachent ce que fait le code) est jugé par le relecteur.

### Le manifeste

Il accompagne le code et dit, en clair, ce que l'app fait :

```yaml
name: factures
description: Lire les factures de mon compte fournisseur.
functions:
  lister_factures: Les factures d'un mois (date, montant, numéro).
  telecharger_facture: Le PDF d'une facture, posé dans les livrables.
secrets:
  FACTURES_USER: Identifiant du compte fournisseur
  FACTURES_PASSWORD: Mot de passe du compte fournisseur
hosts: [ "espace-client.example.com:443" ]
```

### Mise en service

1. **Le dot écrit l'app et son manifeste**, puis demande sa mise en service.
2. **Vérification du cadre**, automatique : sources seulement pour le code du dot, taille (`DOT_APP_MAX_CHARS`), dépendances figées à une version exacte (fichier de verrouillage). Un code qui en sort est refusé tout de suite, avec la raison.
3. **Relecture par un agent**, construit comme un dot, avec un contexte neuf et sans outil qui agit. Il reçoit le code, le manifeste et les **noms** des secrets, jamais leurs valeurs. Sa mission : vérifier la sécurité de l'app dans son ensemble, en commençant par suivre chaque secret dans le code. Il vérifie aussi les vulnérabilités connues (CVE) des dépendances, aux versions exactes du fichier de verrouillage : son seul accès au dehors est la consultation d'une base publique de vulnérabilités (OSV, par exemple), en lecture. Il juge aussi la **provenance** de chaque dépendance : un paquet récent, peu utilisé ou d'un auteur inconnu est signalé, car le dot pourrait publier lui-même un paquet qui fuit, puis en dépendre. Sa consigne précise que le code est une donnée à examiner, pas une consigne à suivre. Il utilise le modèle du dot, sauf si le `.dot` en désigne un autre : son vrai atout est son contexte neuf, qui n'a jamais lu ce qui aurait pu détourner le dot. Un avis défavorable arrête la mise en service ; le dot reçoit les raisons.
4. **Les secrets** : le coffre te prévient, avec le manifeste et l'avis du relecteur, et ajoute au `.dot` une ligne par secret, `value: ""`, avec un commentaire qui dit quoi mettre. Tu les remplis sur ta machine, avec `./dot secret` ou dans le fichier, jamais par Telegram (le dot lit cette conversation). Une valeur vide n'est pas un secret : rien ne part tant qu'elle n'est pas remplie. C'est ce geste qui vaut accord : il n'y en a pas d'autre à donner.
5. **L'app démarre**, et ses fonctions apparaissent chez le dot.

### Pendant qu'elle tourne

- Elle tourne dans un conteneur à part, **`dot-outils`** (un par dot), sur le réseau interne du dot. Le coffre reste petit, et une app boguée ne le touche pas.
- Elle ne sort que par le coffre, vers les serveurs de son manifeste.
- Elle ne reçoit du coffre que les secrets de son manifeste.
- Ses réponses au dot sont masquées : une valeur de ses secrets qui s'y retrouverait est remplacée par son nom.
- Son code est **figé par une empreinte** : toute modification par le dot repasse par les étapes 2 et 3. Ses secrets étant déjà remplis, le relecteur décide seul ; tu es prévenu de ce qui a changé, avec son avis, et tu peux couper l'app.
- **Les vulnérabilités publiées après coup** : les dépendances de chaque app sont revérifiées chaque jour dans la même base, sans modèle. Une nouvelle vulnérabilité qui les concerne t'est signalée, avec sa gravité, et le dot peut proposer une mise à jour de l'app (qui repasse par la relecture).
- **OAuth reste au coffre** : l'app demande son jeton comme un autre secret et le reçoit toujours à jour. Le coffre le renouvelle avant expiration, ou dès qu'un appel est refusé. Si le renouvellement lui-même échoue (autorisation révoquée ou expirée), seule une nouvelle autorisation dans un navigateur peut le réparer : le coffre te prévient, et l'app rend au dot une erreur qui le dit.

## Les défenses, ensemble

| Couche | Ce qu'elle arrête |
|---|---|
| Cadre (porte unique des secrets, sources du dot, taille, dépendances figées) | le code impossible à relire, les accès détournés aux secrets |
| Agent relecteur | les fuites lisibles, accidentelles ou maladroites, les dépendances douteuses ou vulnérables |
| Toi, en remplissant les secrets d'une nouvelle app | une app qui fait autre chose que ce que tu voulais |
| Limites à l'exécution (réseau, masquage, empreinte) | ce qui a échappé aux autres |

Aucune n'est parfaite seule ; il faut toutes les passer pour obtenir un secret.

## Migration

1. Passerelles du modèle et de Telegram, puis la configuration de pi et l'extension Telegram qui les utilisent.
2. Conteneur `dot-outils` : construction depuis les sources, porte des secrets, manifeste, vérification automatique, empreinte.
3. La lecture des mails devient la première app, livrée avec l'image : elle valide le cadre sur du code qui existe déjà.
4. Agent relecteur et parcours de mise en service.
5. Retrait du relais à `{{NOM}}` et des consignes du dot qui en parlent ; mise à jour du README.

Les secrets déjà rangés dans `vault` restent valables : ils seront rattachés à une app au lieu d'être utilisables par le dot.
