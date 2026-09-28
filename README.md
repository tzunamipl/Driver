# Driver POC

Setup:
```
npm install
```

Run:
```
npm run dev
```
Open the printed URL (e.g. http://localhost:5173).

Controls: W/↑ throttle, S/↓ brake-reverse, A/D or ←/→ steer, Space handbrake, R reset car.

Replace placeholder ground photo: put your image at `public/assets/map.jpg` and in
`src/main.js` swap `createPlaceholderMapTexture()` for
`new THREE.TextureLoader().load('/assets/map.jpg')`.
