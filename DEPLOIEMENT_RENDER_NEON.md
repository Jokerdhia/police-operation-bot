# Déploiement du bot sur Render avec Neon

## 1. Créer la base Neon

1. Crée un projet sur Neon.
2. Copie la chaîne de connexion PostgreSQL fournie par Neon.
3. Elle doit ressembler à :
   `postgresql://utilisateur:motdepasse@hote/base?sslmode=require`

Le bot crée automatiquement la table `bot_state` au premier démarrage.

## 2. Mettre le projet sur GitHub

Envoie les fichiers du projet sur un dépôt GitHub. Ne publie jamais ton fichier `.env` ni ton token Discord.

## 3. Créer le service Render

Le fichier `render.yaml` configure un **Background Worker**, adapté à un bot Discord.

Dans Render :

1. Choisis **New > Blueprint**.
2. Connecte le dépôt GitHub.
3. Sélectionne le fichier `render.yaml`.
4. Renseigne toutes les variables marquées comme secrètes.

Variables indispensables :

- `TOKEN`
- `DATABASE_URL`
- `OPERATIONS_CHANNEL_ID`
- `STATS_CHANNEL_ID`
- `SUPERVISOR_ROLE_ID`
- `CHIEF_ROLE_ID`
- `POLICE_ROLE_ID`

## 4. Déployer les commandes Discord

Avant le démarrage normal, exécute une fois :

```bash
npm run deploy
```

Tu peux le faire localement avec les variables Discord nécessaires, puis lancer le service Render.

## Stockage

- Sur Render avec `DATABASE_URL`, les opérations, rapports hebdomadaires et remises à zéro sont enregistrés dans Neon.
- En local sans `DATABASE_URL`, le bot continue d'utiliser les fichiers JSON du dossier `data`.
