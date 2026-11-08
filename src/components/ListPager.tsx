import { Button } from '@astryxdesign/core/Button';
export function ListPager({page,total,size=50,onChange}:{page:number;total:number;size?:number;onChange:(page:number)=>void}) {
  if(total<=size)return null;
  return <nav className="list-pager" aria-label="列表分页"><Button label="上一页" type="button" isDisabled={page===0} onClick={()=>onChange(page-1)} variant="secondary" size="sm" /><span>{page*size+1}–{Math.min(total,(page+1)*size)} / {total}</span><Button label="下一页" type="button" isDisabled={(page+1)*size>=total} onClick={()=>onChange(page+1)} variant="secondary" size="sm" /></nav>;
}
