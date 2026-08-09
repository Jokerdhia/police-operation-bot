# Police Operation Bot V2.0.0 — Production

## Renforcements V2
- Operations Controller / Chief of Police peut examiner sa propre opération.
- Auto-validation explicitement tracée dans les logs.
- Verrou anti-concurrence par opération pendant une décision de revue.
- Relecture de l'état juste avant validation/refus/correction pour éviter les doubles décisions.
- Sauvegarde PostgreSQL/JSON attendue avant les notifications finales de revue.
- Rapport verrouillé après acceptation/refus (boutons retirés).
- Une demande de correction rend le rapport modifiable puis permet une nouvelle soumission.
- Operations Controller et Chief of Police sont tous les deux mentionnés lors d'une nouvelle revue.
- Référence d'erreur courte visible par l'utilisateur et stack complète dans les logs Render.
- Commande `npm run check` ajoutée pour vérifier la syntaxe avant déploiement.

## Déploiement Render
1. Conserver les secrets uniquement dans Render > Environment.
2. Ne jamais envoyer `.env` sur GitHub.
3. Build command recommandé : `npm ci --omit=dev`
4. Start command : `npm start`
5. Après déploiement, vérifier `/health`.

## Variables importantes
- TOKEN
- DATABASE_URL
- SUPERVISOR_ROLE_ID
- CHIEF_ROLE_ID
- POLICE_ROLE_ID
- OPERATIONS_CHANNEL_ID
- STATS_CHANNEL_ID
- LOGS_CHANNEL_ID
