// @vitest-environment jsdom
import {it,expect,vi,afterEach} from 'vitest';
import {render,screen,act,cleanup,waitFor,fireEvent} from '@testing-library/react';
import {useCatalogRevision,invalidateCatalog} from '../src/hooks/useCatalogRevision';
import {UniversalCatalogHealth} from '../src/pages/admin/UniversalCatalogHealth';
import {getUniversalCatalogHealth} from '../src/lib/api';
vi.mock('../src/lib/api',()=>({getUniversalCatalogHealth:vi.fn()}));
afterEach(()=>{cleanup();vi.useRealTimers();vi.resetAllMocks();});
const snapshot=(models:number)=>({models,prepared:520,configurable:0,technical_test_passed:0,integrated:0,operational:0,enabled:0,studio_available:0,problems:models,present:models,removed:0,pricing_missing:models,real_tests_missing:models,details_ok:models,detail_errors:0,last_sync:null,categories:{},measured_at:'2026-11-20T04:00:00Z'});
it('refreshes mounted views on local changes, focus and timer, removing every listener on unmount',()=>{
 vi.useFakeTimers();function Probe(){const revision=useCatalogRevision();return <span>{revision}</span>;}
 const {unmount}=render(<Probe/>);expect(screen.getByText('0')).toBeTruthy();
 act(()=>invalidateCatalog());expect(screen.getByText('1')).toBeTruthy();
 act(()=>window.dispatchEvent(new Event('focus')));expect(screen.getByText('2')).toBeTruthy();
 act(()=>vi.advanceTimersByTime(20000));expect(screen.getByText('3')).toBeTruthy();
 unmount();expect(vi.getTimerCount()).toBe(0);
});
it('uses the universal source, changes counters without reloading and links to real model controls',async()=>{
 const inspect=vi.fn();vi.mocked(getUniversalCatalogHealth).mockResolvedValueOnce(snapshot(861)).mockResolvedValue(snapshot(862));
 render(<UniversalCatalogHealth onInspect={inspect}/>);await screen.findAllByText('861');
 act(()=>invalidateCatalog());await screen.findAllByText('862');
 expect(screen.queryByText('415')).toBeNull();
 fireEvent.click(screen.getByRole('button',{name:'Consulter les modèles et leurs problèmes'}));expect(inspect).toHaveBeenCalledTimes(1);
 await waitFor(()=>expect(getUniversalCatalogHealth).toHaveBeenCalledTimes(2));
});
it('never falls back to the old video count on read errors',async()=>{
 vi.mocked(getUniversalCatalogHealth).mockRejectedValue(new Error('forbidden'));render(<UniversalCatalogHealth/>);
 await screen.findByRole('alert');expect(screen.queryByText('415')).toBeNull();
 expect(screen.getAllByText('—')).toHaveLength(7);
});
