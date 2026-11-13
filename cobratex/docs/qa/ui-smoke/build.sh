FE=/home/claude/cobratex/frontend
/opt/npm-tools/node_modules/.bin/esbuild $FE/src/main.tsx --bundle --outfile=dist/app.js --format=iife --jsx=automatic --sourcemap=inline \
 --alias:react-router-dom=$(dirname $0)/shims/router.jsx --alias:@tanstack/react-query=$(dirname $0)/shims/rq.jsx --alias:axios=$(dirname $0)/shims/axios.js --alias:@=$FE/src \
 --loader:.css=empty --loader:.svg=dataurl --loader:.png=dataurl --loader:.jpg=dataurl --loader:.webp=dataurl \
 --define:import.meta.env.VITE_API_BASE_URL='"http://127.0.0.1:8765/api"' --define:import.meta.env.VITE_BRAND_CONFIG_URL='"/brand.json"' --define:import.meta.env.PROD=false --define:import.meta.env.DEV=true --define:import.meta.env.MODE='"development"' --define:import.meta.env.BASE_URL='"/"' \
 --define:process.env.NODE_ENV='"development"' --log-level=warning 2>&1 | head -30
