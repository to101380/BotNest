// Keep account actions inside the card without hiding signed-out status messages.
const account = document.getElementById("account-page");
const logout = document.getElementById("logout");
const status = document.getElementById("status");
if (account && logout && status) {
  const origin = document.createComment("login status position");
  status.before(origin);
  const footer = document.createElement("div");
  footer.className = "account-card-footer";
  footer.append(logout);
  account.append(footer);
  const update = () => {
    const inAccount = document.body.classList.contains("authenticated") && document.body.classList.contains("account-open");
    if (inAccount && status.parentElement !== footer) footer.append(status);
    else if (!inAccount && status.parentElement === footer) origin.after(status);
  };
  new MutationObserver(update).observe(document.body, { attributes: true, attributeFilter: ["class"] });
  update();
}
