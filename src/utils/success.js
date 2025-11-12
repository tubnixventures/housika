export function generatePropertySuccessEmail({ name, propertyTitle, roomsCreated }) {
  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <style>
    body {
      margin: 0;
      padding: 0;
      font-family: 'Segoe UI', Roboto, Arial, sans-serif;
      background-color: #f4f4f4;
    }
    .container {
      max-width: 700px;
      margin: 40px auto;
      background-color: #ffffff;
      padding: 40px;
      border-radius: 10px;
      box-shadow: 0 4px 20px rgba(0,0,0,0.08);
      text-align: center;
    }
    .tick-icon {
      margin-bottom: 30px;
    }
    h2 {
      color: #2c3e50;
      font-size: 24px;
      margin-bottom: 16px;
    }
    p {
      color: #555555;
      font-size: 16px;
      line-height: 1.6;
      margin: 12px 0;
    }
    .footer {
      margin-top: 40px;
      font-size: 13px;
      color: #777777;
      text-align: center;
    }
    .footer a {
      color: #b31b1b;
      text-decoration: none;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="tick-icon">
      <svg width="80" height="80" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
        <circle cx="12" cy="12" r="10" fill="#28a745"/>
        <path d="M7 12.5L10 15.5L17 8.5" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
    </div>
    <h2>Congratulations, ${name || 'User'}!</h2>
    <p>Your property <strong>${propertyTitle}</strong> has been successfully added to Housika.</p>
    <p>${roomsCreated} room${roomsCreated === 1 ? '' : 's'} were registered and are now available for listing.</p>
    <p>We’re excited to help you connect with tenants and grow your portfolio.</p>
    <div class="footer">
      <p>Housika Properties is operated under Pansoft Technologies Kenya.</p>
      <p>Need help? <a href="mailto:customercare@housika.co.ke">customercare@housika.co.ke</a></p>
    </div>
  </div>
</body>
</html>
  `;
}
