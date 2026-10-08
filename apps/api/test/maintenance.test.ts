import { afterAll, describe, expect, it } from 'vitest';
import { disconnectPrisma, getPrisma } from '@cdn/database';
import { aggregateDay } from '../src/worker/maintenance.js';

afterAll(async () => {
  await disconnectPrisma();
});

describe('daily request aggregation', () => {
  it('aggregates an empty day and is repeatable with download, view and click rows', async () => {
    const prisma = getPrisma();
    const emptyDay = new Date('2020-01-01T12:00:00.000Z');
    await aggregateDay(emptyDay);
    const empty = await prisma.analyticsDaily.findUniqueOrThrow({
      where: { date_dimension_dimensionId: { date: new Date('2020-01-01'), dimension: 'total', dimensionId: '' } },
    });
    expect(empty.requests).toBe(0n);

    const day = new Date('2020-01-02T00:00:00.000Z');
    for (const trafficType of ['download', 'view', 'click']) {
      await prisma.fileRequest.create({
        data: { timestamp: day, method: 'GET', route: '/files/test', statusCode: 200,
          bytesSent: 10n, responseMs: 2, kind: 'delivery', trafficType },
      });
    }
    await aggregateDay(day);
    await aggregateDay(day);
    const total = await prisma.analyticsDaily.findUniqueOrThrow({
      where: { date_dimension_dimensionId: { date: day, dimension: 'total', dimensionId: '' } },
    });
    expect(total.requests).toBe(3n);
    expect(total.downloads).toBe(1n);
    expect(total.views).toBe(1n);
    expect(total.clicks).toBe(1n);
    expect(total.bytes).toBe(30n);
  });
});
