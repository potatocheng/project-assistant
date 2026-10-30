export function ListPager({page,total,size=50,onChange}:{page:number;total:number;size?:number;onChange:(page:number)=>void}) {
  if(total<=size)return null;
  return <nav className="list-pager" aria-label="列表分页"><button type="button" className="button secondary compact" disabled={page===0} onClick={()=>onChange(page-1)}>上一页</button><span>{page*size+1}–{Math.min(total,(page+1)*size)} / {total}</span><button type="button" className="button secondary compact" disabled={(page+1)*size>=total} onClick={()=>onChange(page+1)}>下一页</button></nav>;
}
