# Firestore rules requeridas para lealtad (promociones + niveles)

Para evitar el error **Missing or insufficient permissions** en el módulo `/lealtad`, las reglas deben incluir acceso para estas colecciones:

- `loyalty_customers`
- `loyalty_movements`
- `loyalty_config`
- `loyalty_rewards`
- `loyalty_promotions`
- `loyalty_levels`

## Ejemplo base (ajústalo a tu auth real)

```firestore
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    function isAdmin() {
      return request.auth != null && request.auth.token.admin == true;
    }

    match /loyalty_customers/{docId} {
      allow read, create, update: if isAdmin();
      allow delete: if false;
    }

    match /loyalty_movements/{docId} {
      allow read, create: if isAdmin();
      allow update, delete: if false;
    }

    match /loyalty_config/{docId} {
      allow read, write: if isAdmin();
    }

    match /loyalty_rewards/{docId} {
      allow read: if true;
      allow write: if isAdmin();
    }

    match /loyalty_promotions/{docId} {
      allow read, write: if isAdmin();
    }

    match /loyalty_levels/{docId} {
      allow read, write: if isAdmin();
    }
  }
}
```

> Si la app pública de tarjeta leerá promociones activas o niveles sin login, habilita lectura pública restringida por campos (`active == true`) mediante reglas más finas o una capa backend.
