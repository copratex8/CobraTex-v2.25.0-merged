import { Router } from 'express';
import { createItem, createItemCategory, createUom, getItemById, listItems, listUoms, listItemCategories, updateItemStatus } from '@/modules/items/itemService';
import { validate } from '@/middleware/validate';
import { idParamSchema, toggleActiveBodySchema } from '@/shared/zodSchemas';
import { paginationQuerySchema, parsePagination } from '@/shared/pagination';

export const itemsRouter = Router();

itemsRouter.post('/item-categories', async (req, res, next) => {
  try {
    const category = await createItemCategory(req.ctx, req.body);
    res.status(201).json(category);
  } catch (err) {
    next(err);
  }
});

itemsRouter.post('/uoms', async (req, res, next) => {
  try {
    const { nameAr, nameEn, symbol } = req.body ?? {};
    const uom = await createUom(req.ctx, nameAr, nameEn, symbol);
    res.status(201).json(uom);
  } catch (err) {
    next(err);
  }
});

itemsRouter.post('/items', async (req, res, next) => {
  try {
    const item = await createItem(req.ctx, req.body);
    res.status(201).json(item);
  } catch (err) {
    next(err);
  }
});

itemsRouter.get('/items/:id', validate({ params: idParamSchema }), async (req, res, next) => {
  try {
    const item = await getItemById(req.ctx, String(req.params.id));
    if (!item) return res.status(404).json({ error: 'الصنف غير موجود' });
    res.json(item);
  } catch (err) {
    next(err);
  }
});

itemsRouter.get('/items', validate({ query: paginationQuerySchema }), async (req, res, next) => {
  try {
    const { page, pageSize } = parsePagination(req.query as Record<string, unknown>);
    res.status(200).json(await listItems(req.ctx, page, pageSize));
  } catch (err) { next(err); }
});

itemsRouter.get('/uoms', async (req, res, next) => {
  try { res.status(200).json(await listUoms(req.ctx)); } catch (err) { next(err); }
});

itemsRouter.get('/item-categories', async (req, res, next) => {
  try { res.status(200).json(await listItemCategories(req.ctx)); } catch (err) { next(err); }
});

itemsRouter.patch('/items/:id', validate({ params: idParamSchema, body: toggleActiveBodySchema }), async (req, res, next) => {
  try {
    res.status(200).json(await updateItemStatus(req.ctx, String(req.params.id), req.body.isActive));
  } catch (err) { next(err); }
});
