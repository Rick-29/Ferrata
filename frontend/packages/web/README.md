# Ferrata — site web (prototype)

Site vitrine, connexion Swissquote simulée, profil investisseur et tableau de bord avec le wallet
intégré. **Prototype front-end uniquement** : données de démonstration, aucun appel réseau, aucun
vrai fonds. Issu de Figma Make, adapté aux décisions de l'équipe (pas de blocage sur le risque,
seulement un refus réglementaire ; pas de pump.fun ; nom du produit dans `../brand`).

```sh
cd frontend/packages/web
npm install
npm run dev      # http://localhost:5174
npm run build    # vérifie les types puis construit dans dist/
```

Le nom du produit (`APP_NAME`, « Ferrata ») vient de `frontend/packages/brand/src/index.ts`,
partagé avec l'extension et l'appli mobile.
