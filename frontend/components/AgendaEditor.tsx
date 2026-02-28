"use client";

interface AgendaItem {
  id: number;
  topic: string;
  description: string;
  duration_minutes: number;
}

interface Agenda {
  title: string;
  items: AgendaItem[];
  total_minutes: number;
}

interface AgendaEditorProps {
  agenda: Agenda;
  onUpdate: (agenda: Agenda) => void;
}

export default function AgendaEditor({ agenda, onUpdate }: AgendaEditorProps) {
  const totalUsed = agenda.items.reduce(
    (sum, item) => sum + item.duration_minutes,
    0
  );

  const withUpdatedItems = (items: AgendaItem[]): Agenda => ({
    ...agenda,
    items,
  });

  const updateItem = (
    id: number,
    field: keyof AgendaItem,
    value: string | number
  ) => {
    const newItems = agenda.items.map((item) =>
      item.id === id ? { ...item, [field]: value } : item
    );
    onUpdate(withUpdatedItems(newItems));
  };

  const removeItem = (id: number) => {
    onUpdate(withUpdatedItems(agenda.items.filter((item) => item.id !== id)));
  };

  const addItem = () => {
    const newId = Math.max(0, ...agenda.items.map((i) => i.id)) + 1;
    onUpdate(
      withUpdatedItems([
        ...agenda.items,
        {
          id: newId,
          topic: "New Topic",
          description: "",
          duration_minutes: 5,
        },
      ])
    );
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between text-sm text-gray-400">
        <span>Agenda Items</span>
        <span
          className={totalUsed > agenda.total_minutes ? "text-red-400" : ""}
        >
          {totalUsed} / {agenda.total_minutes} min
        </span>
      </div>

      {agenda.items.map((item, index) => (
        <div
          key={item.id}
          className="flex items-center gap-3 bg-gray-900 border border-gray-800 rounded-lg p-3"
        >
          <span className="text-gray-500 text-sm w-6">{index + 1}.</span>
          <input
            type="text"
            value={item.topic}
            onChange={(e) => updateItem(item.id, "topic", e.target.value)}
            className="flex-1 bg-transparent text-white focus:outline-none"
          />
          <div className="flex items-center gap-1">
            <input
              type="number"
              value={item.duration_minutes}
              onChange={(e) =>
                updateItem(
                  item.id,
                  "duration_minutes",
                  Math.max(1, parseInt(e.target.value) || 1)
                )
              }
              className="w-14 bg-gray-800 border border-gray-700 rounded px-2 py-1 text-center text-sm text-white focus:outline-none focus:border-blue-500"
              min={1}
            />
            <span className="text-gray-500 text-sm">min</span>
          </div>
          <button
            onClick={() => removeItem(item.id)}
            className="text-gray-500 hover:text-red-400 text-sm"
          >
            x
          </button>
        </div>
      ))}

      <button
        onClick={addItem}
        className="w-full py-2 border border-dashed border-gray-700 rounded-lg text-gray-400 hover:text-white hover:border-gray-500 transition-colors text-sm"
      >
        + Add item
      </button>
    </div>
  );
}
