# Oreille

Une PWA qui écoute 60 secondes de nature et te dit ce qui vit autour.
Stack : Next.js 15 + TF.js (BirdNET + YAMNet, client-side) + iNaturalist/GBIF + Claude.

## Pourquoi PWA

Distribution **gratuite, instantanée, partout** :
- iOS Safari → « Ajouter à l'écran d'accueil »
- Android Chrome → prompt d'install natif
- Desktop → installable depuis la barre d'URL
- (optionnel) Microsoft Store via [PWABuilder](https://www.pwabuilder.com/) — gratuit
- (optionnel) Google Play via Bubblewrap — 25 $ une fois

Apple App Store coûte 99 $/an et n'est volontairement pas couvert ici.

## Run local

```bash
npm install
cp .env.example .env.local   # puis colle ta clé Anthropic
npm run dev
```

## Déploiement Vercel

1. Push sur GitHub (compte `kpeartree`).
2. Sur vercel.com → New Project → import du repo.
3. Settings → Environment Variables → `ANTHROPIC_API_KEY`.
4. Deploy. Chaque push donne une preview URL.

## Modèles à déposer dans `public/models/`

L'inférence est 100 % côté client. Pour activer la vraie reconnaissance :

- `public/models/birdnet/` — modèle TFJS depuis [georg95/birdnet-web](https://github.com/georg95/birdnet-web) (`models/birdnet_v2/`)
- `public/models/yamnet/`  — conversion TFJS de [YAMNet](https://www.kaggle.com/models/google/yamnet) (Google AudioSet, ~521 classes incluant grillons, cigales, abeilles, grenouilles, vent, ruisseau, etc.)

Tant que ces dossiers ne sont pas présents, `app/lib/inference.ts` retourne une prédiction stub déterministe et le reste du pipeline (narration, UI, géoloc) reste fonctionnel.

## Licences à valider avant tout usage commercial

- BirdNET : modèle Cornell, **CC BY-NC 4.0** (non commercial). OK pour usage perso.
- YAMNet : **Apache 2.0**.
- iNaturalist / GBIF : APIs publiques, citation requise.
