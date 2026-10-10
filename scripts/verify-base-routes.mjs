import fs from 'node:fs';
import {createPublicClient, http, parseAbi, keccak256, zeroAddress, encodeAbiParameters, parseAbiParameters} from 'viem';
// Read-only provenance and small-quote checks. Does not authorize a route or submit transactions.
const c=JSON.parse(fs.readFileSync('config/chains.json','utf8')).chains.find(x=>x.chainId===8453);
const catalog=JSON.parse(fs.readFileSync('evidence/base-live-catalog.json','utf8'));
let nextRead=Promise.resolve();
const paced=async(method,run)=>{
  const before=nextRead; let release; nextRead=new Promise(r=>{release=r;}); await before;
  try{
    for(let attempt=0;;attempt++)try{return await run();}catch(e){
      if(attempt>=2||!String(e.shortMessage??e.message).concat(String(e.details??'')).match(/rate|429/i))throw e;
      await new Promise(r=>setTimeout(r,5000*(attempt+1)));
    }
  }finally{await new Promise(r=>setTimeout(r,650));release();}
};
const direct=createPublicClient({transport:http(c.publicRpc,{timeout:12000,retryCount:0})});
const rpc=new Proxy(direct,{get(target,key){const v=target[key];return typeof v==='function'?(...args)=>paced(String(key),()=>v(...args)):v;}});
if(await rpc.getChainId()!==8453)throw Error('Incorrect network');
const head=await rpc.getBlock(); const bn=head.number;
const rc=(address,abi,functionName,args=[])=>rpc.readContract({address,abi,functionName,args,blockNumber:bn});
const abi=parseAbi(['function getPool(address,address,uint24) view returns(address)','function factory() view returns(address)','function token0() view returns(address)','function token1() view returns(address)','function fee() view returns(uint24)','function tickSpacing() view returns(int24)','function liquidity() view returns(uint128)','function decimals() view returns(uint8)','function symbol() view returns(string)','function AQUA() view returns(address)','function aqua() view returns(address)','function aquaSwapVMRouter() view returns(address)','function currentAquaHash(bytes32) view returns(bytes32)','function strategyClassId(bytes32) view returns(uint256)','function getStrategyTokens(bytes32) view returns(address[])']);
const qa=parseAbi(['function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96)) returns(uint256,uint160,uint32,uint256)']);
const same=(a,b)=>a.toLowerCase()===b.toLowerCase();
const result={capturedAt:new Date().toISOString(),chainId:8453,blockNumber:String(bn),blockHash:head.hash,mode:'observe-only',broadcast:false,dependencies:{},tokens:[],externalPools:[],v4Pools:[],swapVM:[]};
const hash=async address=>{const code=await rpc.getCode({address,blockNumber:bn});if(!code||code==='0x')throw Error('No deployed code');return keccak256(code);};
const tokenMap=new Map(); for(const row of [...catalog.v4,...catalog.aqua])for(const t of (row.tokens??row.market?.tokens??[]))tokenMap.set(t.address.toLowerCase(),t);
for(const t of tokenMap.values()){
 const [decimals,symbol,codeHash]=await Promise.all([rc(t.address,abi,'decimals'),rc(t.address,abi,'symbol'),hash(t.address)]);
 if(decimals!==t.decimals)throw Error('Token decimal mismatch'); result.tokens.push({...t,readSymbol:symbol,decimals,codeHash});
}
for(const [label,address] of Object.entries({poolManager:c.poolManager,universalRouter:c.universalRouter,permit2:c.permit2,hook:c.aqua0Hook,swapVM:c.swapVM.router,aqua:c.swapVM.aqua,maker:c.swapVM.maker}))result.dependencies[label]={address,codeHash:await hash(address)};
const pairs=new Map(); for(const x of catalog.v4)pairs.set([x.pool.currency0.toLowerCase(),x.pool.currency1.toLowerCase()].sort().join(':'),[x.pool.currency0,x.pool.currency1]); for(const x of catalog.aqua)pairs.set([x.market.token0.toLowerCase(),x.market.token1.toLowerCase()].sort().join(':'),[x.market.token0,x.market.token1]);
const tasks=[]; for(const venue of c.venues)for(const [pair,tokens] of pairs)for(const fee of venue.fees)tasks.push({venue,pair,tokens,fee});
let cursor=0;
async function run(){while(cursor<tasks.length){const t=tasks[cursor++];const row={venue:t.venue.name,factory:t.venue.factory,quoter:t.venue.quoter,pair:t.pair,fee:t.fee};try{
 const address=await rc(t.venue.factory,abi,'getPool',[...t.tokens,t.fee]); row.address=address;
 if(same(address,zeroAddress)){row.status='not-deployed';result.externalPools.push(row);continue;}
 const [factory,token0,token1,fee,spacing,liquidity,codeHash,qfactory]=await Promise.all([rc(address,abi,'factory'),rc(address,abi,'token0'),rc(address,abi,'token1'),rc(address,abi,'fee'),rc(address,abi,'tickSpacing'),rc(address,abi,'liquidity'),hash(address),rc(t.venue.quoter,abi,'factory')]);
 if(!same(factory,t.venue.factory)||!same(qfactory,factory)||fee!==t.fee||[token0.toLowerCase(),token1.toLowerCase()].sort().join(':')!==t.pair)throw Error('Factory, quoter or token binding mismatch');
 Object.assign(row,{token0,token1,tickSpacing:spacing,liquidity:String(liquidity),codeHash,quoterFactory:qfactory,quotes:[]});
 if(liquidity===0n){row.status='no-active-liquidity';result.externalPools.push(row);continue;}
 for(const [input,output] of [[token0,token1],[token1,token0]]){
  const meta=result.tokens.find(x=>same(x.address,input)); const weth=same(input,'0x4200000000000000000000000000000000000006'); const amount=weth?10n**14n:10n**BigInt(meta.decimals)/10n;
  try{const q=await rc(t.venue.quoter,qa,'quoteExactInputSingle',[{tokenIn:input,tokenOut:output,amountIn:amount,fee,sqrtPriceLimitX96:0n}]); row.quotes.push({tokenIn:input,amountIn:String(amount),amountOut:String(q[0]),gasEstimate:String(q[3])});}catch(e){row.quotes.push({tokenIn:input,error:e.shortMessage??e.name});}
 }
 row.status=row.quotes.every(x=>x.amountOut&&BigInt(x.amountOut)>0n)?'verified-small-quotes':'quote-unavailable';
 }catch(e){row.status='read-failed';row.error=e.shortMessage??e.name;}result.externalPools.push(row);}}
await Promise.all([run(),run()]);
for(const row of catalog.v4){const p=row.pool;const calculated=keccak256(encodeAbiParameters(parseAbiParameters('(address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks)'),[p]));result.v4Pools.push({pool:p,classIds:row.classIds,poolIdVerified:same(calculated,p.poolId),hookVerified:same(p.hooks,c.aqua0Hook),externalCandidates:result.externalPools.filter(x=>x.pair===[p.currency0.toLowerCase(),p.currency1.toLowerCase()].sort().join(':')&&x.status==='verified-small-quotes').map(x=>x.address),pricePolicyStillApplies:true});}
for(const row of catalog.aqua){const m=row.market;const rec={...m,approval:false};try{
 const [aqua,makerAqua,router,current,cls,tokens]=await Promise.all([rc(m.router,abi,'AQUA'),rc(m.maker,abi,'aqua'),rc(m.maker,abi,'aquaSwapVMRouter'),rc(m.maker,abi,'currentAquaHash',[m.stableStrategyId]),rc(m.maker,abi,'strategyClassId',[m.stableStrategyId]),rc(m.maker,abi,'getStrategyTokens',[m.stableStrategyId])]);
 const orderHash=keccak256(encodeAbiParameters(parseAbiParameters('(address maker,uint256 traits,bytes data)'),[{...m.order,traits:BigInt(m.order.traits)}]));
 if(!same(aqua,m.aqua)||!same(makerAqua,aqua)||!same(router,m.router)||!same(current,orderHash)||String(cls)!==m.classId||tokens.length!==2||tokens.map(x=>x.toLowerCase()).sort().join(':')!==[m.token0.toLowerCase(),m.token1.toLowerCase()].sort().join(':'))throw Error('Live order, maker or class changed');
 rec.identityVerified=true;rec.verifiedBlock=String(bn);rec.verifiedHash=head.hash;
 rec.externalCandidates=result.externalPools.filter(x=>x.pair===[m.token0.toLowerCase(),m.token1.toLowerCase()].sort().join(':')&&x.status==='verified-small-quotes').map(x=>x.address);
}catch(e){rec.identityVerified=false;rec.error=e.shortMessage??e.message;}result.swapVM.push(rec);}
result.canonical=(await rpc.getBlock({blockNumber:bn})).hash===head.hash;if(!result.canonical)throw Error('Verification block reorganized');
result.externalPools.sort((a,b)=>(a.venue+a.pair+a.fee).localeCompare(b.venue+b.pair+b.fee));
fs.writeFileSync('evidence/base-verified-routes.json',JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify({block:result.blockNumber,canonical:result.canonical,external:result.externalPools.filter(x=>x.status==='verified-small-quotes').map(x=>({venue:x.venue,pool:x.address,pair:x.pair,fee:x.fee})),unavailable:result.externalPools.filter(x=>x.status==='read-failed'||x.status==='quote-unavailable'),aqua:result.swapVM.map(x=>({classId:x.classId,verified:x.identityVerified,external:x.externalCandidates,error:x.error}))},null,2));
