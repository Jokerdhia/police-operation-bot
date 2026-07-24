# Corrections effectuées

- Confirmation immédiate des boutons et menus Discord (`deferUpdate`) pour éviter l'erreur 10062 `Unknown interaction`.
- Remplacement des mises à jour tardives par `editReply`.
- Réponses d'erreur éphémères compatibles avec les interactions déjà confirmées.
- Serveur HTTP Express avec routes `/` et `/health` pour Render Web Service et les monitors.
- `render.yaml` configuré en Web Service gratuit.
- Période hebdomadaire réelle du lundi au dimanche, à la place du mode test de 5 minutes.
- Arrêt propre du serveur HTTP, de Discord et de Neon.
- Ajout de `.env.example`.
