# Police Operation Bot v2.1.0

- Fiabilisation de la sauvegarde Neon/JSON : les écritures critiques sont maintenant attendues avant de confirmer l'action Discord.
- Classements et rapports plus fiables : rafraîchissement contrôlé des membres avant le calcul des policiers actifs.
- Protection des preuves : limite de 10 MB avant téléchargement en mémoire.
- Gestion globale des erreurs `unhandledRejection` et `uncaughtException` pour améliorer les diagnostics Render.
- Conservation des protections déjà présentes : verrou anti-double-validation, détection de preuve dupliquée, anti-farm, nettoyage des rapports abandonnés, health endpoint.
- Le fichier `.env` réel et `node_modules` ne sont volontairement pas inclus dans l'archive distribuable.
