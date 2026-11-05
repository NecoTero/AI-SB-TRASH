/* Actual source labels from the updated KSP fact file (27.09.2026). */
(()=>{'use strict';const traits=window.DEMO?.traits;if(!traits)return;const add=(traitId,master,aliases)=>{const value=traits.find(trait=>trait.id===traitId)?.values.find(item=>item.name===master);if(!value)return;for(const alias of aliases)if(!value.aliases.includes(alias))value.aliases.push(alias);};
add('corpus','Корпус А',['Корпус А оси А2-М / 1-9']);
add('corpus','Корпус Б',['Корпус Б оси А2-М / 9-17']);
add('corpus','Корпус В',["Корпус В оси А'-Л' / 1'-6'"]);
add('floor','Этаж 1',['1 этаж на отм. -0.200','Монтаж стальных витражных конструкций 1го этажа','Устройство кровли 1 этажа']);
add('floor','Этаж 2',['2 этаж на отм. +7.150','Монтаж модульных конструкций 2 го этажа']);
add('floor','Этаж 3',['3 этаж на отм. +11.500','Монтаж модульных конструкций 3го этажа']);
add('floor','Этаж 4',['4 этаж на отм. +15.700','Монтаж модульных конструкций 4го этажа']);
add('floor','Этаж 5',['5 этаж на отм. +19.900','Монтаж модульных конструкций 5го этажа']);
add('floor','Этаж 6',['6 этаж на отм. +24.100']);
add('floor','Этаж 7',['7 этаж на отм. +28.300; +29,500','Устройство кровли 7 этажа']);
add('floor','Этаж 8',['8 этаж на отм. +33.500']);
add('floor','Этаж -1',['Подземная часть на отм. -6.350','Монтаж стальных витражных конструкций -1го этажа','Устройство кровли -1 этажа']);
const noBimKfo=new Set(['204.02.04.03','204.02.04.04','204.02.04.05','204.02.04.09','204.02.04.10']);
const constructionStageFor=code=>{
  if(noBimKfo.has(code))return null;
  if(/^204\.02\.02\./.test(code))return'Фундамент';
  if(/^204\.02\.03\./.test(code))return'Shell&Core';
  if(/^204\.02\.05\./.test(code))return'Фасады';
  if(/^204\.02\.06\./.test(code))return'Кровля';
  if(/^204\.(02\.(04|07)|03|04|05)\./.test(code))return'FitOut';
  return null;
};
if(!traits.some(trait=>trait.id==='constructionStage')){
  const values=['Фундамент','Shell&Core','Фасады','Кровля','FitOut'].map(name=>({name,aliases:[]}));
  const byName=new Map(values.map(value=>[value.name,value]));
  const kfo=traits.find(trait=>trait.id==='kfo');
  for(const value of kfo?.values||[]){const stage=constructionStageFor(value.name);if(stage)byName.get(stage).aliases.push(value.name);}
  traits.push({id:'constructionStage',name:'Строительный этап',derivedFrom:'kfo',replaceAliases:true,keys:['Код КФО'],values});
}
})();
