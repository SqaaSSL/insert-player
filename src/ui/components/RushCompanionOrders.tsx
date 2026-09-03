import {
  RUSH_COMPANION_ORDERS,
  type RushCompanionOrder,
} from '../../game/brawl/RushConfig.ts';

interface RushCompanionOrdersProps {
  value: RushCompanionOrder;
  onChange: (order: RushCompanionOrder) => void;
}

export function RushCompanionOrders({ value, onChange }: RushCompanionOrdersProps) {
  return (
    <section className="rush-orders" aria-label="CPU partner order">
      <span className="rush-orders__label">CPU ORDER</span>
      <div className="rush-orders__buttons">
        {RUSH_COMPANION_ORDERS.map((order, index) => (
          <button
            key={order.id}
            type="button"
            className={order.id === value ? 'is-active' : undefined}
            aria-pressed={order.id === value}
            title={`${index + 1} · ${order.blurb}`}
            onClick={() => onChange(order.id)}
          >
            <span>{index + 1}</span>
            {order.shortLabel}
          </button>
        ))}
      </div>
    </section>
  );
}
